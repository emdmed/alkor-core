// The dev overlay client — a framework-agnostic vanilla script served by
// `medprotocol overlay --serve` at GET /overlay.js. Its job is to retrofit
// medical-protocol into apps that were built WITHOUT it: the doctor hovers ANY
// element on ANY page, selects it, and chooses to Audit that region, Implement it
// with medical protocol, or Add a brand-new component there from a free-text brief
// typed into the overlay. Selection does not require the app to be tagged —
// the overlay captures a CSS selector + outerHTML + text so the agent can locate
// the region in source and classify it. `data-medprotocol-*` tags, when present,
// are used only as an optional fast-path hint.
//
// It POSTs a work order back to the serving origin (POST /queue), never runs
// clinical logic, and is inert in production (loaded in dev only).
//
// Kept as a string (no template-literal `${}` inside) so tsup bundles it into
// the single CLI dist without a separate asset.

export const OVERLAY_CLIENT_JS = `(function () {
  if (window.__medprotocolOverlay) return;
  window.__medprotocolOverlay = true;

  var script = document.currentScript;
  var BASE = script ? new URL(script.src).origin : window.location.origin;
  var active = false;
  var current = null;
  var raf = null;
  var tracked = [];   // orders still being polled (not yet done)
  var markers = [];   // all on-screen markers, including completed-with-result (for repositioning)
  var pollTimer = null;
  var panelOrder = null;

  function el(tag, cls) { var e = document.createElement(tag); e.className = cls; return e; }

  // Technical stroke icons (24x24, currentColor) — no emoji anywhere in this UI.
  function svgIcon(body, size) {
    return '<svg class="mpo-ic" width="' + (size || 14) + '" height="' + (size || 14) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  }
  var ICONS = {
    reticle: '<circle cx="12" cy="12" r="6.5"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>',
    frame: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
    audit: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-3.6-3.6"/>',
    implement: '<path d="M8.5 6 3.5 12l5 6M15.5 6l5 6-5 6"/>',
    add: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M12 8.5v7M8.5 12h7"/>',
    modify: '<path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3z"/><path d="M14 7.5 16.5 10"/>',
    send: '<path d="M4 12l16-7-7 16-2.5-6.5L4 12z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="1.5"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
    cancel: '<path d="M6 6l12 12M18 6 6 18"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="M4 12.5 9 17.5 20 6.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'
  };

  // Clinical catalog — mirrors classification.md signal words so the overlay can suggest the right
  // tool from a selection and offer the registry as named chips. This is keyword HINTING only; no
  // clinical logic runs in the browser. The agent still classifies authoritatively when it drains.
  var CATALOG = [
    { label: 'BMI', brief: 'a BMI calculator', words: ['bmi', 'body mass index', 'obesity', 'underweight', 'overweight', 'weight', 'height'] },
    { label: 'Vital signs', brief: 'a vital signs panel', words: ['blood pressure', 'heart rate', 'pulse', 'oxygen', 'spo2', 'temperature', 'respiratory rate', 'vitals'] },
    { label: 'Blood gas (ABG)', brief: 'an arterial blood gas (ABG) analyzer', words: ['ph', 'blood gas', 'abg', 'arterial blood gas', 'acidosis', 'alkalosis', 'anion gap', 'bicarbonate', 'pco2'] },
    { label: 'Fluid balance', brief: 'a fluid balance (intake/output) tracker', words: ['fluid balance', 'intake', 'output', 'diuresis', 'insensible', 'fluid management'] },
    { label: 'PaO2/FiO2', brief: 'a PaO2/FiO2 (PaFi) calculator', words: ['pafi', 'pao2', 'fio2', 'ards', 'oxygenation', 'respiratory failure', 'lung injury'] },
    { label: 'DKA', brief: 'a DKA monitoring tool', words: ['dka', 'ketoacidosis', 'ketones', 'insulin drip', 'glucose monitoring'] },
    { label: 'Sepsis', brief: 'a sepsis (SOFA/qSOFA) assessment', words: ['sepsis', 'sofa', 'qsofa', 'septic shock', 'organ failure', 'lactate', 'vasopressors', 'resuscitation'] },
    { label: 'Diabetes', brief: 'a diabetes diagnosis tool', words: ['diabetes', 'a1c', 'hba1c', 'fasting glucose', 'ogtt', 'prediabetes', 'gestational diabetes'] },
    { label: 'Cardiology', brief: 'a cardiovascular risk calculator', words: ['ascvd', 'cardiovascular risk', 'heart score', 'chest pain', 'cha2ds2', 'atrial fibrillation', 'cardiac risk'] },
    { label: 'Kidney (CKD)', brief: 'a CKD / kidney function tool', words: ['ckd', 'chronic kidney', 'egfr', 'creatinine', 'kidney function', 'kdigo', 'nephrology', 'proteinuria', 'albuminuria', 'dialysis'] }
  ];

  // Starting points for a MODIFY brief. These are not a fixed command set — they seed the textarea
  // so the doctor edits a sentence instead of facing a blank box, and anything can be typed instead.
  var MODIFY_PRESETS = [
    { label: 'Remove this', brief: 'remove this entirely' },
    { label: 'Add a field', brief: 'add a field here for ' },
    { label: 'Reword it', brief: 'reword the text here to be clearer for a clinician' },
    { label: 'Make it bigger', brief: 'make this bigger and easier to read at a glance' },
    { label: 'Add an alert', brief: 'flag out-of-range values here with a visible warning' }
  ];

  // First catalog entry whose signal words appear (as whole tokens) in the selection's text/classes.
  function detectDomain(node) {
    var hay = (((node && node.textContent) || '') + ' ' + ((node && node.getAttribute && node.getAttribute('class')) || '')).toLowerCase();
    if (!hay.trim()) return null;
    for (var i = 0; i < CATALOG.length; i++) {
      var words = CATALOG[i].words;
      for (var j = 0; j < words.length; j++) {
        if (new RegExp('(^|[^a-z])' + words[j] + '([^a-z]|$)').test(hay)) return CATALOG[i];
      }
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Inline markdown applied to ALREADY-escaped text: code spans, bold, italic, links.
  function inlineMd(s) {
    return s
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\\*([^*\\s][^*]*?)\\*/g, '$1<em>$2</em>')
      .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  // Minimal, safe Markdown → HTML for the result panel. Escapes first, then structures,
  // so any raw HTML in an agent-authored report is neutralized (never executed).
  function renderMarkdown(md) {
    var lines = String(md).replace(/\\r\\n?/g, '\\n').split('\\n');
    var out = '', listType = null, inCode = false, code = [];
    function closeList() { if (listType) { out += '</' + listType + '>'; listType = null; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\\s*\`\`\`/.test(ln)) {
        if (inCode) { out += '<pre><code>' + code.join('\\n') + '</code></pre>'; code = []; inCode = false; }
        else { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { code.push(escapeHtml(ln)); continue; }
      var t = ln.replace(/\\s+$/, '');
      if (!t.trim()) { closeList(); continue; }
      var h = t.match(/^(#{1,6})\\s+(.*)$/);
      if (h) { closeList(); var lv = h[1].length; out += '<h' + lv + '>' + inlineMd(escapeHtml(h[2])) + '</h' + lv + '>'; continue; }
      if (/^\\s*(---+|\\*\\*\\*+|___+)\\s*$/.test(t)) { closeList(); out += '<hr>'; continue; }
      var ul = t.match(/^\\s*[-*+]\\s+(.*)$/);
      if (ul) { if (listType !== 'ul') { closeList(); out += '<ul>'; listType = 'ul'; } out += '<li>' + inlineMd(escapeHtml(ul[1])) + '</li>'; continue; }
      var ol = t.match(/^\\s*\\d+[.)]\\s+(.*)$/);
      if (ol) { if (listType !== 'ol') { closeList(); out += '<ol>'; listType = 'ol'; } out += '<li>' + inlineMd(escapeHtml(ol[1])) + '</li>'; continue; }
      closeList();
      out += '<p>' + inlineMd(escapeHtml(t)) + '</p>';
    }
    if (inCode) out += '<pre><code>' + code.join('\\n') + '</code></pre>';
    closeList();
    return out;
  }

  // Is this element part of the overlay's own UI? Never select those.
  function isOwn(node) {
    return !!(node && node.closest && node.closest('.mpo-ui'));
  }

  // The desktop shell's faces. It bundles them; a plain browser almost never
  // has them, so each stack falls through to the same system face the shell
  // would have used anyway — the overlay never waits on a webfont it cannot
  // fetch from a project's own origin.
  var MONO = '"IBM Plex Mono",ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace';
  var SANS = '"Instrument Sans Variable",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  // The medprotocol desktop shell's paper theme, transposed to flat hex.
  //
  // The shell keeps these as OKLCH in its own stylesheet; here they are the
  // resolved sRGB, because this client is injected into whatever browser the
  // project happens to be open in and cannot assume oklch() parses. Same
  // ladder, same names: background is the sheet, panel is fixed chrome, card
  // is content resting on either. Colour stays rationed — moss means live or
  // actionable, clay means in flight, brick means broken.
  //
  // Scoped to .mpo-ui rather than :root so nothing here can leak into the
  // page being inspected.
  var TOKENS =
    '.mpo-ui{' +
    '--mpo-bg:#f7f3e9;--mpo-panel:#f0eadd;--mpo-card:#fdfbf5;--mpo-elevated:#f9f5ed;' +
    '--mpo-fg:#2e231b;--mpo-muted:#ede7db;--mpo-muted-fg:#685c53;--mpo-subtle-fg:#71655a;' +
    '--mpo-border:#dcd6cb;--mpo-input:#908879;--mpo-border-strong:#786f61;' +
    '--mpo-primary:#326840;--mpo-primary-fg:#f5fdf6;--mpo-primary-hover:#255a33;--mpo-primary-active:#1d4c2a;' +
    '--mpo-secondary:#ece6d9;--mpo-secondary-fg:#362b23;--mpo-secondary-hover:#e2dcce;--mpo-secondary-active:#d9d2c3;' +
    '--mpo-warning:#8f5821;--mpo-destructive:#b13b2d;' +
    '--mpo-primary-tint:#d2efd7;--mpo-warning-tint:#fce4c5;--mpo-destructive-tint:#ffdcd4;' +
    // Paper casts a short, warm shadow: every one of these is tinted with the
    // sepia ink rather than neutral black, because grey shade on a warm stock
    // reads as dirt.
    '--mpo-e1:0 1px 1px 0 rgba(46,35,27,.035),0 1px 2px 0 rgba(46,35,27,.05);' +
    '--mpo-e2:0 1px 2px 0 rgba(46,35,27,.08),0 2px 5px -2px rgba(46,35,27,.09);' +
    '--mpo-float:0 14px 34px -14px rgba(46,35,27,.2);' +
    '--mpo-ease:cubic-bezier(0.25,1,0.5,1);' +
    '}';

  // Toast status lights, set inline on the dot. Moss for a thing that landed,
  // clay for a thing waiting on someone, brick for a thing that broke, and
  // plain ink for an acknowledgement that carries no status at all.
  var TONE = { ok: '#326840', warn: '#8f5821', error: '#b13b2d', info: '#685c53' };

  var style = document.createElement('style');
  style.textContent = [
    TOKENS,
    '.mpo-ui,.mpo-ui *{box-sizing:border-box}',
    '.mpo-ic{display:inline-block;vertical-align:middle;flex:0 0 auto}',
    // Every control in the shell transitions colour and transform only, on the
    // same exponential ease-out, and presses a hair into the surface.
    // Both selectors in each pair: the toggle carries .mpo-ui itself, every
    // other button is a descendant of a root that does.
    '.mpo-ui button,button.mpo-ui{transition:background-color .15s var(--mpo-ease),color .15s var(--mpo-ease),border-color .15s var(--mpo-ease),box-shadow .15s var(--mpo-ease),transform .15s var(--mpo-ease),opacity .15s var(--mpo-ease)}',
    '.mpo-ui button:active:not([disabled]),button.mpo-ui:active:not([disabled]){transform:translateY(1px)}',
    // Focus is always the signal colour, never a browser default, and it is
    // ringed against paper so it survives whatever the host page is painted.
    '.mpo-ui button:focus-visible,button.mpo-ui:focus-visible{outline:none;box-shadow:0 0 0 2px var(--mpo-card),0 0 0 4px rgba(50,104,64,.6)}',
    // Collapsing an infinite animation to 0.01ms leaves it cycling through
    // colours a frame at a time, which is worse than the motion it replaced —
    // so the beacon is switched off outright rather than merely shortened.
    '@media (prefers-reduced-motion:reduce){.mpo-ui,.mpo-ui *,.mpo-ui *::before,.mpo-ui *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}.mpo-toggle{animation:none!important}}',
    // Selection reticle: a thin tinted frame with solid moss corner brackets. The
    // outer ring is paper rather than ink so the frame stays legible over a dark
    // region of the page being inspected.
    '.mpo-box{position:fixed;z-index:2147483646;pointer-events:none;border:1px solid rgba(50,104,64,.4);background:rgba(50,104,64,.06);box-shadow:0 0 0 1px rgba(253,251,245,.75);display:none}',
    '.mpo-corner{position:absolute;width:10px;height:10px;border:1.5px solid var(--mpo-primary)}',
    '.mpo-corner.tl{top:-1px;left:-1px;border-right:none;border-bottom:none}',
    '.mpo-corner.tr{top:-1px;right:-1px;border-left:none;border-bottom:none}',
    '.mpo-corner.bl{bottom:-1px;left:-1px;border-right:none;border-top:none}',
    '.mpo-corner.br{bottom:-1px;right:-1px;border-left:none;border-top:none}',
    // Label readout tag: struck mono on a card chip. Near-opaque rather than
    // solid, because it sits directly on the element it names.
    '.mpo-badge{position:fixed;z-index:2147483647;pointer-events:none;background:rgba(253,251,245,.96);color:var(--mpo-fg);border:1px solid var(--mpo-border);border-radius:5px;box-shadow:var(--mpo-e1);font:500 10.5px/1.5 ' + MONO + ';letter-spacing:-.006em;padding:2px 6px;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    // The toggle rests as an outline control and fills with the signal colour
    // when select mode is on — the one thing on the page that means live.
    //
    // It also has to be found. The overlay is injected into a page that knows
    // nothing about it, so at rest the toggle wears a broad 3px border that
    // cycles through the palette's three saturated roles under a widening
    // halo — the one deliberately loud thing the overlay draws. The border is
    // thick from the start and only its colour animates, so the control never
    // changes size and never reflows the corner it sits in.
    '@keyframes mpo-beacon{' +
    '0%{border-color:var(--mpo-primary);box-shadow:var(--mpo-e2),0 0 0 0 rgba(50,104,64,.45)}' +
    '35%{border-color:var(--mpo-warning);box-shadow:var(--mpo-e2),0 0 0 7px rgba(143,88,33,0)}' +
    '70%{border-color:var(--mpo-destructive);box-shadow:var(--mpo-e2),0 0 0 0 rgba(177,59,45,.4)}' +
    '100%{border-color:var(--mpo-primary);box-shadow:var(--mpo-e2),0 0 0 7px rgba(50,104,64,0)}' +
    '}',
    // Padding is 2px short of the resting control's on each side, so growing
    // the border to 3px keeps the button exactly the size it would have been.
    '.mpo-toggle{position:fixed;bottom:16px;right:16px;z-index:2147483647;display:inline-flex;align-items:center;gap:8px;background:var(--mpo-card);color:var(--mpo-fg);font:600 12px/1 ' + SANS + ';letter-spacing:-.006em;border:3px solid var(--mpo-primary);border-radius:10px;padding:7px 11px;cursor:pointer;box-shadow:var(--mpo-e2);animation:mpo-beacon 3.2s var(--mpo-ease) infinite}',
    // Hovering is the doctor answering it, so the beacon stops and the control
    // behaves like every other outline button in the shell.
    '.mpo-toggle:hover{animation:none;border-color:var(--mpo-border-strong);background:var(--mpo-secondary)}',
    '.mpo-toggle:active{animation:none;background:var(--mpo-secondary-hover)}',
    // On is the calm state: it found its reader, so it stops shouting and
    // settles into the flat signal fill.
    '.mpo-toggle[data-on="1"]{animation:none;background:var(--mpo-primary);border-color:var(--mpo-primary);color:var(--mpo-primary-fg);box-shadow:var(--mpo-e2)}',
    '.mpo-toggle[data-on="1"]:hover{background:var(--mpo-primary-hover);border-color:var(--mpo-primary-hover)}',
    '.mpo-toggle[data-on="1"]:active{background:var(--mpo-primary-active);border-color:var(--mpo-primary-active)}',
    '.mpo-toggle .mpo-ic{color:var(--mpo-muted-fg)}',
    '.mpo-toggle[data-on="1"] .mpo-ic{color:var(--mpo-primary-fg)}',
    '.mpo-menu{position:fixed;z-index:2147483647;background:var(--mpo-card);border:1px solid var(--mpo-border);border-radius:12px;padding:5px;box-shadow:var(--mpo-float);font:500 13px/1 ' + SANS + ';display:none;min-width:248px;max-width:340px}',
    '.mpo-menu button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;border:none;color:var(--mpo-fg);padding:9px 11px;border-radius:5px;cursor:pointer;white-space:nowrap;font:500 13px/1.2 ' + SANS + '}',
    '.mpo-menu button .mpo-ic{color:var(--mpo-muted-fg)}',
    '.mpo-menu button:hover{background:var(--mpo-muted)}',
    '.mpo-menu button:hover .mpo-ic{color:var(--mpo-primary)}',
    '.mpo-head{display:flex;align-items:center;gap:7px;padding:7px 11px 8px;color:var(--mpo-muted-fg);font:500 11px/1.4 ' + MONO + ';letter-spacing:-.006em;border-bottom:1px solid var(--mpo-border);margin-bottom:4px}',
    '.mpo-head .mpo-ic{color:var(--mpo-subtle-fg)}',
    '.mpo-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mpo-hint{padding:6px 11px 4px;color:var(--mpo-subtle-fg);font:400 10.5px/1.45 ' + SANS + '}',
    // Two-line menu buttons: outcome label on top, plain-language subtitle under it (no dev jargon).
    '.mpo-menu button{align-items:flex-start}',
    '.mpo-menu button>.mpo-ic{margin-top:1px}',
    '.mpo-btn-tx{display:flex;flex-direction:column;gap:2px;min-width:0;white-space:normal;text-align:left}',
    '.mpo-btn-tx b{font:600 13px/1.25 ' + SANS + ';color:var(--mpo-fg);letter-spacing:-.01em}',
    '.mpo-sub{font:400 10.5px/1.35 ' + SANS + ';color:var(--mpo-subtle-fg)}',
    // Smart suggestion: the keyword-matched top action — the one tinted fill in
    // the menu, so it reads as the recommended pick without shouting.
    '.mpo-menu button.mpo-smart{background:var(--mpo-primary-tint);border:1px solid rgba(50,104,64,.25);margin-bottom:4px}',
    '.mpo-menu button.mpo-smart:hover{background:var(--mpo-primary-tint);border-color:rgba(50,104,64,.5)}',
    '.mpo-menu button.mpo-smart>.mpo-ic{color:var(--mpo-primary)}',
    '.mpo-menu button.mpo-smart:hover>.mpo-ic{color:var(--mpo-primary)}',
    '.mpo-menu button.mpo-smart b{color:var(--mpo-primary)}',
    // Footer: dev-only affordances (copy selector / cancel) demoted out of the primary actions.
    '.mpo-menu-foot{display:flex;gap:4px;margin-top:5px;padding-top:6px;border-top:1px solid var(--mpo-border)}',
    '.mpo-menu-foot button{flex:1;justify-content:center;align-items:center;color:var(--mpo-muted-fg);padding:7px 8px;font:500 11.5px/1 ' + SANS + '}',
    '.mpo-menu-foot button .mpo-ic{color:var(--mpo-subtle-fg)}',
    // Catalog chips: the registry surfaced as clickable clinical names in the Add panel.
    '.mpo-cat{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0}',
    '.mpo-cat-head{width:100%;color:var(--mpo-subtle-fg);font:500 10px/1.4 ' + MONO + ';letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px}',
    '.mpo-chip{background:var(--mpo-secondary);color:var(--mpo-secondary-fg);border:1px solid transparent;border-radius:999px;padding:5px 11px;cursor:pointer;font:500 11.5px/1 ' + SANS + '}',
    '.mpo-chip:hover{background:var(--mpo-secondary-hover);border-color:var(--mpo-border-strong)}',
    '.mpo-toast{position:fixed;bottom:64px;right:16px;z-index:2147483647;display:flex;align-items:center;gap:8px;background:var(--mpo-card);color:var(--mpo-fg);font:500 12.5px/1.45 ' + SANS + ';padding:10px 13px;border-radius:8px;border:1px solid var(--mpo-border);box-shadow:var(--mpo-float);transition:opacity .3s;max-width:340px}',
    '.mpo-toast .mpo-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:0 0 auto}',
    '@keyframes mpo-spin{to{transform:rotate(360deg)}}',
    '@keyframes mpo-pulse{0%,100%{opacity:.5}50%{opacity:1}}',
    // In-flight work is clay, finished work is moss, and queued-with-nobody-
    // draining is uncoloured — a stopped thing that looks eventful is a lie.
    '.mpo-track-box{position:fixed;z-index:2147483645;pointer-events:none;border:1px dashed var(--mpo-warning);display:none;animation:mpo-pulse 1.2s ease-in-out infinite}',
    '.mpo-track-box.done{border-style:solid;border-color:var(--mpo-primary);animation:none}',
    '.mpo-track-box.waiting{border-style:dashed;border-color:var(--mpo-input);animation:none}',
    '.mpo-track-pill{position:fixed;z-index:2147483647;pointer-events:none;display:none;align-items:center;gap:6px;background:var(--mpo-warning-tint);color:var(--mpo-warning);border:1px solid rgba(143,88,33,.25);font:500 10.5px/1.4 ' + MONO + ';letter-spacing:-.006em;padding:3px 8px;border-radius:999px;box-shadow:var(--mpo-e1);white-space:nowrap}',
    '.mpo-track-pill.done{background:var(--mpo-primary-tint);color:var(--mpo-primary);border-color:rgba(50,104,64,.25)}',
    '.mpo-track-pill.waiting{background:transparent;color:var(--mpo-subtle-fg);border-color:var(--mpo-border);box-shadow:none}',
    '.mpo-track-pill.waiting .mpo-ic{color:var(--mpo-subtle-fg)}',
    '.mpo-spin{width:10px;height:10px;border:2px solid rgba(143,88,33,.25);border-top-color:var(--mpo-warning);border-radius:50%;display:inline-block;animation:mpo-spin .7s linear infinite}',
    '.mpo-clickable{pointer-events:auto;cursor:pointer}',
    // On a light surface an interaction darkens; brightening reads as the
    // control lifting away from the pointer.
    '.mpo-clickable:hover{filter:brightness(.96)}',
    '.mpo-panel{position:fixed;top:8vh;right:16px;z-index:2147483647;width:min(540px,92vw);max-height:80vh;display:none;flex-direction:column;background:var(--mpo-card);color:var(--mpo-fg);border:1px solid var(--mpo-border);border-radius:12px;box-shadow:var(--mpo-float)}',
    // The head is fixed chrome, so it sits a step darker than the body it caps.
    '.mpo-panel-head{display:flex;align-items:center;gap:8px;padding:11px 12px;background:var(--mpo-panel);border-bottom:1px solid var(--mpo-border);border-radius:11px 11px 0 0}',
    '.mpo-panel-title{flex:1;min-width:0;font:500 11px/1.4 ' + MONO + ';letter-spacing:-.006em;color:var(--mpo-muted-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mpo-panel-btn{display:inline-flex;align-items:center;gap:5px;background:var(--mpo-card);color:var(--mpo-fg);border:1px solid var(--mpo-input);border-radius:5px;padding:5px 9px;cursor:pointer;box-shadow:var(--mpo-e1);font:500 11px/1 ' + SANS + '}',
    '.mpo-panel-btn:hover{background:var(--mpo-secondary);border-color:var(--mpo-border-strong)}',
    '.mpo-panel-btn:active{background:var(--mpo-secondary-hover)}',
    '.mpo-panel-btn.icon{padding:5px 6px}',
    '.mpo-panel-btn.primary{background:var(--mpo-primary);border-color:transparent;color:var(--mpo-primary-fg);box-shadow:var(--mpo-e2)}',
    '.mpo-panel-btn.primary:hover{background:var(--mpo-primary-hover)}',
    '.mpo-panel-btn.primary:active{background:var(--mpo-primary-active)}',
    '.mpo-panel-btn[disabled]{opacity:.4;cursor:not-allowed;box-shadow:none}',
    '.mpo-panel-body{padding:14px 16px;overflow:auto;word-break:break-word;font:400 13px/1.6 ' + SANS + ';color:var(--mpo-muted-fg)}',
    '.mpo-panel-body>*:first-child{margin-top:0}',
    '.mpo-panel-body>*:last-child{margin-bottom:0}',
    '.mpo-panel-body h1,.mpo-panel-body h2,.mpo-panel-body h3,.mpo-panel-body h4{margin:16px 0 7px;color:var(--mpo-fg);font-weight:600;line-height:1.3;letter-spacing:-.01em}',
    '.mpo-panel-body h1{font-size:15px}',
    '.mpo-panel-body h2{font-size:14px;padding-bottom:5px;border-bottom:1px solid var(--mpo-border)}',
    '.mpo-panel-body h3{font-size:11px;color:var(--mpo-subtle-fg);letter-spacing:.06em;text-transform:uppercase}',
    '.mpo-panel-body h4{font-size:12px;color:var(--mpo-muted-fg)}',
    '.mpo-panel-body p{margin:7px 0}',
    '.mpo-panel-body ul,.mpo-panel-body ol{margin:7px 0;padding-left:20px}',
    '.mpo-panel-body li{margin:3px 0}',
    '.mpo-panel-body li::marker{color:var(--mpo-input)}',
    '.mpo-panel-body strong{color:var(--mpo-fg);font-weight:600}',
    '.mpo-panel-body em{color:var(--mpo-fg)}',
    '.mpo-panel-body code{font:500 11.5px/1.4 ' + MONO + ';letter-spacing:-.006em;background:var(--mpo-muted);color:var(--mpo-fg);border:1px solid var(--mpo-border);border-radius:5px;padding:1px 5px}',
    '.mpo-panel-body pre{margin:9px 0;padding:11px 12px;background:var(--mpo-muted);border:1px solid var(--mpo-border);border-radius:8px;overflow:auto}',
    '.mpo-panel-body pre code{background:none;border:none;padding:0;color:var(--mpo-fg);font-weight:400;font-size:12px;line-height:1.55}',
    '.mpo-panel-body hr{border:none;border-top:1px solid var(--mpo-border);margin:12px 0}',
    '.mpo-panel-body a{color:var(--mpo-primary)}',
    '.mpo-score{display:inline-flex;align-items:center;gap:8px;margin:0 0 12px;padding:5px 11px;background:var(--mpo-primary-tint);border:1px solid rgba(50,104,64,.25);border-radius:8px;font:600 12px/1 ' + MONO + ';letter-spacing:-.006em;color:var(--mpo-primary)}',
    '.mpo-score .mpo-score-k{color:var(--mpo-muted-fg);font-weight:500}',
    // Inline skill trigger: a /medical-protocol:x mention in the report, clickable to re-run it here.
    '.mpo-skill{display:inline;background:var(--mpo-primary-tint);color:var(--mpo-primary);border:1px solid rgba(50,104,64,.25);border-radius:5px;padding:1px 6px;margin:0 1px;font:500 11.5px/1.4 ' + MONO + ';letter-spacing:-.006em;cursor:pointer}',
    '.mpo-skill:hover{border-color:rgba(50,104,64,.55)}',
    // Suggested-actions row: structured skill triggers the report attached to its result.
    '.mpo-suggest{margin-top:16px;padding-top:13px;border-top:1px solid var(--mpo-border);display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
    '.mpo-suggest-head{width:100%;color:var(--mpo-subtle-fg);font:500 11px/1.4 ' + MONO + ';letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px}',
    '.mpo-suggest-btn{display:inline-flex;align-items:center;gap:6px;background:var(--mpo-primary);color:var(--mpo-primary-fg);border:1px solid transparent;border-radius:8px;padding:6px 11px;cursor:pointer;box-shadow:var(--mpo-e2);font:500 12px/1 ' + SANS + '}',
    '.mpo-suggest-btn:hover{background:var(--mpo-primary-hover)}',
    '.mpo-suggest-btn:active{background:var(--mpo-primary-active)}',
    '.mpo-suggest-btn .mpo-ic{color:var(--mpo-primary-fg)}',
    // Compose panel: free-text "add a component here" brief the doctor types for the agent.
    '.mpo-compose-body{padding:13px 16px 4px;display:flex;flex-direction:column;gap:9px}',
    '.mpo-compose-target{font:500 10.5px/1.4 ' + MONO + ';letter-spacing:-.006em;color:var(--mpo-subtle-fg)}',
    '.mpo-compose-target b{color:var(--mpo-fg);font-weight:500}',
    '.mpo-compose textarea{width:100%;min-height:96px;resize:vertical;background:var(--mpo-card);color:var(--mpo-fg);border:1px solid var(--mpo-input);border-radius:8px;box-shadow:var(--mpo-e1);padding:10px 12px;font:400 13px/1.55 ' + SANS + ';transition:border-color .15s var(--mpo-ease),box-shadow .15s var(--mpo-ease)}',
    '.mpo-compose textarea:hover{border-color:var(--mpo-border-strong)}',
    '.mpo-compose textarea:focus{outline:none;border-color:rgba(50,104,64,.5);box-shadow:0 0 0 2px rgba(50,104,64,.45)}',
    '.mpo-compose textarea::placeholder{color:var(--mpo-subtle-fg)}',
    '.mpo-compose-hint{color:var(--mpo-subtle-fg);font:400 10.5px/1.45 ' + SANS + '}',
    '.mpo-compose-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px 14px}',
    '.mpo-compose-foot .mpo-panel-btn[disabled]{opacity:.4;cursor:not-allowed;box-shadow:none}'
  ].join('');
  document.head.appendChild(style);

  var box = el('div', 'mpo-box mpo-ui');
  ['tl', 'tr', 'bl', 'br'].forEach(function (p) { box.appendChild(el('span', 'mpo-corner ' + p)); });
  var badge = el('div', 'mpo-badge mpo-ui');
  var menu = el('div', 'mpo-menu mpo-ui');
  var toggle = el('button', 'mpo-toggle mpo-ui');
  toggle.innerHTML = svgIcon(ICONS.reticle) + '<span>Protocol select</span>';

  // Result panel (singleton)
  var panel = el('div', 'mpo-panel mpo-ui');
  var panelTitle = el('div', 'mpo-panel-title');
  var panelBody = el('div', 'mpo-panel-body');
  var panelApply = el('button', 'mpo-panel-btn primary');
  (function buildPanel() {
    var head = el('div', 'mpo-panel-head');
    panelApply.innerHTML = svgIcon(ICONS.check, 13) + '<span>Apply</span>';
    panelApply.title = 'Land the staged diff into source';
    panelApply.style.display = 'none';
    panelApply.addEventListener('click', function () { if (panelOrder) applyOrder(panelOrder); });
    var dismiss = el('button', 'mpo-panel-btn'); dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', function () { if (panelOrder) dropMarker(panelOrder); closePanel(); });
    var close = el('button', 'mpo-panel-btn icon'); close.title = 'Close'; close.innerHTML = svgIcon(ICONS.close, 13);
    close.addEventListener('click', closePanel);
    head.appendChild(panelTitle); head.appendChild(panelApply); head.appendChild(dismiss); head.appendChild(close);
    panel.appendChild(head); panel.appendChild(panelBody);
    // Delegate clicks on any skill trigger inside the report (inline chips + the suggested-actions row).
    panelBody.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.mpo-skill,.mpo-suggest-btn') : null;
      if (!b || !panelOrder) return;
      e.preventDefault();
      runSkill(panelOrder, b.getAttribute('data-skill'), b.getAttribute('data-prompt'));
    });
  })();

  // Compose panel (singleton) — typing a free-text brief against the selected area. It serves two
  // actions: ADD (build a new component in here) and MODIFY (change what is already here). They share
  // one panel because they are the same gesture to the doctor: say what you want, in words.
  var compose = el('div', 'mpo-panel mpo-ui');
  var composeTitle = el('div', 'mpo-panel-title');
  var composeTarget = el('div', 'mpo-compose-target');
  var composeInput = document.createElement('textarea');
  var composeSubmit = el('button', 'mpo-panel-btn primary');
  var composeNode = null; // the element the brief applies to
  var composeMode = 'add'; // 'add' | 'modify'
  var composeChips = null; // chip row, repopulated per mode
  var composeHint = null;

  // Everything that differs between the two modes, so openCompose is a lookup rather than a branch.
  var COMPOSE_MODES = {
    add: {
      title: 'ADD COMPONENT',
      target: 'Add into ',
      chipHead: 'Common tools',
      presets: CATALOG,
      submit: 'Add',
      placeholder: 'Describe the component to add here, e.g. "a chronic kidney disease anemia tracker".',
      hint: 'A headless Claude run builds it with medical protocol and applies it into the selected area. ⌘/Ctrl+Enter to submit.'
    },
    modify: {
      title: 'CHANGE THIS REGION',
      target: 'Change ',
      chipHead: 'Common changes',
      presets: MODIFY_PRESETS,
      submit: 'Change',
      placeholder: 'Describe the change in plain words, e.g. "remove this" or "add a creatinine field".',
      hint: 'Layout and presentation changes are applied straight into the code. Anything that would change clinical logic — thresholds, formulas, alert rules — is staged for your approval instead. ⌘/Ctrl+Enter to submit.'
    }
  };

  (function buildCompose() {
    var head = el('div', 'mpo-panel-head');
    var close = el('button', 'mpo-panel-btn icon'); close.title = 'Close'; close.innerHTML = svgIcon(ICONS.close, 13);
    close.addEventListener('click', closeCompose);
    head.appendChild(composeTitle); head.appendChild(close);

    var body = el('div', 'mpo-compose-body');
    body.classList.add('mpo-compose');
    composeInput.setAttribute('rows', '4');
    composeHint = el('div', 'mpo-compose-hint');

    // Chips: a starting sentence rather than a blank box. Repopulated per mode by openCompose.
    composeChips = el('div', 'mpo-cat');

    body.appendChild(composeTarget); body.appendChild(composeChips); body.appendChild(composeInput); body.appendChild(composeHint);

    var foot = el('div', 'mpo-compose-foot');
    var cancel = el('button', 'mpo-panel-btn'); cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeCompose);
    composeSubmit.addEventListener('click', submitCompose);
    foot.appendChild(cancel); foot.appendChild(composeSubmit);

    composeInput.addEventListener('input', function () { composeSubmit.disabled = !composeInput.value.trim(); });
    composeInput.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitCompose(); }
      if (e.key === 'Escape') { e.stopPropagation(); closeCompose(); }
    });

    compose.appendChild(head); compose.appendChild(body); compose.appendChild(foot);
  })();

  function openCompose(node, mode) {
    composeMode = mode === 'modify' ? 'modify' : 'add';
    var cfg = COMPOSE_MODES[composeMode];

    composeNode = node;
    composeInput.value = '';
    composeInput.placeholder = cfg.placeholder;
    composeSubmit.disabled = true;
    composeSubmit.innerHTML = svgIcon(ICONS.send, 13) + '<span></span>';
    composeSubmit.querySelector('span').textContent = cfg.submit;
    composeTitle.textContent = cfg.title;
    composeHint.textContent = cfg.hint;
    composeTarget.innerHTML = escapeHtml(cfg.target) + '<b>' + escapeHtml(label(node)) + '</b>';

    composeChips.innerHTML = '';
    var chipHead = el('div', 'mpo-cat-head'); chipHead.textContent = cfg.chipHead;
    composeChips.appendChild(chipHead);
    cfg.presets.forEach(function (p) {
      var chip = el('button', 'mpo-chip'); chip.type = 'button'; chip.textContent = p.label;
      chip.title = p.brief;
      chip.addEventListener('click', function () {
        // Seeds the box rather than submitting: a preset is a first draft, and several of them
        // ("add a field here for ") are deliberately unfinished sentences.
        composeInput.value = p.brief;
        composeSubmit.disabled = !p.brief.trim();
        composeInput.focus();
        composeInput.setSelectionRange(p.brief.length, p.brief.length);
      });
      composeChips.appendChild(chip);
    });

    compose.style.display = 'flex';
    setTimeout(function () { composeInput.focus(); }, 0);
  }
  function closeCompose() { compose.style.display = 'none'; composeNode = null; }
  function submitCompose() {
    var prompt = composeInput.value.trim();
    if (!prompt || !composeNode) return;
    send(composeMode, composeNode, prompt);
    closeCompose();
  }

  function mount() {
    document.body.appendChild(box);
    document.body.appendChild(badge);
    document.body.appendChild(menu);
    document.body.appendChild(toggle);
    document.body.appendChild(panel);
    document.body.appendChild(compose);
  }
  if (document.body) { mount(); } else { document.addEventListener('DOMContentLoaded', mount); }

  function hideHighlight() { box.style.display = 'none'; badge.style.display = 'none'; }
  function hideMenu() { menu.style.display = 'none'; }

  function setActive(on) {
    active = on;
    toggle.setAttribute('data-on', on ? '1' : '0');
    toggle.innerHTML = svgIcon(ICONS.reticle) + '<span>' + (on ? 'Selecting — ↑ widen · Esc' : 'Protocol select') + '</span>';
    if (!on) { hideHighlight(); hideMenu(); current = null; }
  }
  toggle.addEventListener('click', function (e) { e.stopPropagation(); setActive(!active); });

  // Short human label for the highlighted node: registry id if tagged, else tag(.class).
  function label(node) {
    var id = node.getAttribute && node.getAttribute('data-medprotocol-id');
    if (id) return id;
    var t = node.tagName ? node.tagName.toLowerCase() : 'node';
    if (node.id) return t + '#' + node.id;
    var c = (node.getAttribute && node.getAttribute('class')) || '';
    c = c.split(/\\s+/).filter(Boolean)[0];
    return c ? t + '.' + c : t;
  }

  function highlight(node) {
    if (!node || node === document.body || node === document.documentElement) { hideHighlight(); return; }
    var r = node.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    badge.style.display = 'block';
    badge.textContent = label(node);
    badge.style.left = r.left + 'px';
    badge.style.top = Math.max(0, r.top - 22) + 'px';
  }

  document.addEventListener('mousemove', function (e) {
    if (!active || menu.style.display === 'block' || raf) return;
    raf = requestAnimationFrame(function () {
      raf = null;
      var node = e.target;
      if (isOwn(node)) { return; }
      current = node;
      highlight(node);
    });
  }, true);

  // ArrowUp widens the selection to the parent element (Impeccable-style).
  document.addEventListener('keydown', function (e) {
    if (!active) return;
    if (e.key === 'Escape') {
      if (menu.style.display === 'block') { hideMenu(); } else { setActive(false); }
      return;
    }
    if (e.key === 'ArrowUp' && current && current.parentElement && menu.style.display !== 'block') {
      e.preventDefault();
      if (current.parentElement !== document.body) { current = current.parentElement; highlight(current); }
    }
  });
  window.addEventListener('scroll', function () {
    if (active && menu.style.display !== 'block') highlight(current);
    if (tracked.length) repositionAll();
  }, true);
  window.addEventListener('resize', function () { if (tracked.length) repositionAll(); });

  document.addEventListener('click', function (e) {
    if (!active || isOwn(e.target) || !current) return;
    e.preventDefault(); e.stopPropagation();
    openMenu(e.clientX, e.clientY, current);
  }, true);

  // Primary action: outcome label on top, plain-language subtitle under it. "smart" accents it as the
  // recommended, keyword-matched pick.
  function menuBtn(icon, title, sub, fn, smart) {
    var b = document.createElement('button');
    if (smart) b.className = 'mpo-smart';
    b.innerHTML = svgIcon(icon) + '<span class="mpo-btn-tx"><b></b><span class="mpo-sub"></span></span>';
    b.querySelector('b').textContent = title;
    b.querySelector('.mpo-sub').textContent = sub;
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
    return b;
  }

  // Demoted, single-line footer action (copy selector / cancel) — dev affordances, not primary.
  function footBtn(icon, txt, fn) {
    var b = document.createElement('button');
    b.innerHTML = svgIcon(icon, 13) + '<span></span>';
    b.querySelector('span').textContent = txt;
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
    return b;
  }

  function openMenu(x, y, node) {
    menu.innerHTML = '';
    var head = el('div', 'mpo-head'); head.innerHTML = svgIcon(ICONS.frame, 13) + '<span></span>';
    head.querySelector('span').textContent = label(node); menu.appendChild(head);

    // Smart suggestion: if the selection's text matches a known clinical tool, offer it as a one-click
    // top action — no jargon, no typing. Maps to Implement (retrofit the existing markup in place).
    var hit = detectDomain(node);
    if (hit) {
      menu.appendChild(menuBtn(ICONS.implement,
        'Looks like ' + hit.label + ' — make this the ' + hit.label + ' calculator',
        'Replaces this region with the validated ' + hit.label + ' component',
        function () { send('implement', node); }, true));
    }

    menu.appendChild(menuBtn(ICONS.audit, 'Check this against the protocol',
      'Review only — nothing changes', function () { send('audit', node); }));
    menu.appendChild(menuBtn(ICONS.implement, 'Make this a real calculator',
      'Replaces it with the matching validated component', function () { send('implement', node); }));
    menu.appendChild(menuBtn(ICONS.modify, 'Change something here…',
      'Say it in words — applied straight into the code',
      function () { hideMenu(); openCompose(node, 'modify'); }));
    menu.appendChild(menuBtn(ICONS.add, 'Add a calculator here…',
      'Pick from the catalog or describe one', function () { hideMenu(); openCompose(node, 'add'); }));

    var foot = el('div', 'mpo-menu-foot');
    foot.appendChild(footBtn(ICONS.copy, 'Copy selector', function () { copy(cssPath(node)); hideMenu(); }));
    foot.appendChild(footBtn(ICONS.cancel, 'Cancel', function () { hideMenu(); }));
    menu.appendChild(foot);

    var hint = el('div', 'mpo-hint'); hint.textContent = 'Tip: press ↑ before clicking to widen the selection.';
    menu.appendChild(hint);
    menu.style.display = 'block';
    menu.style.left = Math.min(x, window.innerWidth - 300) + 'px';
    // Tracks the tallest the menu gets (smart suggestion + four actions + footer + hint), so it
    // still opens fully on screen when clicked near the bottom edge.
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 360)) + 'px';
  }

  // Build a reasonably stable CSS selector from the node up to <body>.
  function cssPath(node) {
    if (!node || !node.tagName) return '';
    var parts = [];
    var n = node;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 8) {
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      var tag = n.tagName.toLowerCase();
      var i = 1, sib = n;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === n.tagName) i++; }
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      n = n.parentElement;
    }
    return parts.join(' > ');
  }

  function send(action, node, prompt) {
    hideMenu();
    var order = {
      action: action,
      prompt: prompt || null,   // free-text brief — required for "add" and "modify", null otherwise
      selector: cssPath(node),
      tag: node.tagName ? node.tagName.toLowerCase() : null,
      classes: (node.getAttribute && node.getAttribute('class')) || null,
      text: (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      html: (node.outerHTML || '').slice(0, 4000),
      rect: (function () { var r = node.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      suggestedId: (node.closest && node.closest('[data-medprotocol-id]') ? node.closest('[data-medprotocol-id]').getAttribute('data-medprotocol-id') : null),
      source: (node.closest && node.closest('[data-medprotocol-source]') ? node.closest('[data-medprotocol-source]').getAttribute('data-medprotocol-source') : null),
      url: location.href,
      ts: new Date().toISOString(),
      status: 'pending'
    };
    fetch(BASE + '/queue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order)
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (resp) {
      toast('Queued ' + action + ' for <' + (order.tag || 'node') + '>', TONE.ok);
      track(resp.file, order.selector, action);
    }).catch(function (err) {
      toast('Queue failed: ' + err.message + ' — is "medprotocol overlay --serve" running?', TONE.error);
    });
  }

  // ── Progress markers: pin a spinner over the selected element until the agent finishes ──

  // Per-action labels for the live marker: { queued, ing, done }.
  function verbs(action) {
    if (action === 'audit') return { queued: 'queued audit…', ing: 'auditing…', done: 'audited' };
    if (action === 'add') return { queued: 'queued add…', ing: 'adding…', done: 'added' };
    if (action === 'skill') return { queued: 'queued…', ing: 'running…', done: 'ran' };
    if (action === 'modify') return { queued: 'queued change…', ing: 'changing…', done: 'changed' };
    return { queued: 'queued implement…', ing: 'implementing…', done: 'implemented' };
  }

  // The skill that drains each action, named so the doctor knows exactly what to run.
  function drainHint(action) {
    var skill = action === 'audit' ? '/medical-protocol:overlay-audit'
      : action === 'add' ? '/medical-protocol:overlay-add'
      : action === 'modify' ? '/medical-protocol:modify'
      : action === 'skill' ? 'the overlay queue'
      : '/medical-protocol:overlay-implement';
    return 'Queued, but the server is in --no-auto mode — nothing will run on its own. Process it in Claude Code ('
      + skill + '), or restart the server without --no-auto (autonomous is the default).';
  }

  // (Re)build a pill as an active spinner with the given label. Used for queued (auto) and processing.
  function spinnerPill(t, text) {
    t.pill.classList.remove('done', 'waiting', 'mpo-clickable');
    t.pill.onclick = null;
    t.pill.innerHTML = '';
    var spin = el('span', 'mpo-spin');
    var lbl = document.createElement('span'); lbl.textContent = text;
    t.pill.appendChild(spin); t.pill.appendChild(lbl);
    t.label = lbl;
  }

  function track(file, selector, action) {
    if (!file) return;
    var b = el('div', 'mpo-track-box mpo-ui');
    var p = el('div', 'mpo-track-pill mpo-ui');
    var spin = el('span', 'mpo-spin');
    var lbl = document.createElement('span');
    lbl.textContent = verbs(action).queued;
    p.appendChild(spin); p.appendChild(lbl);
    document.body.appendChild(b); document.body.appendChild(p);
    var t = { file: file, selector: selector, action: action, box: b, pill: p, label: lbl, done: false, mode: 'init' };
    tracked.push(t); markers.push(t);
    positionMarker(t);
    startPolling();
  }

  function positionMarker(t) {
    var node = null;
    try { node = t.selector ? document.querySelector(t.selector) : null; } catch (e) { node = null; }
    if (!node) { t.box.style.display = 'none'; t.pill.style.display = 'none'; return; }
    var r = node.getBoundingClientRect();
    t.box.style.display = 'block';
    t.box.style.left = r.left + 'px'; t.box.style.top = r.top + 'px';
    t.box.style.width = r.width + 'px'; t.box.style.height = r.height + 'px';
    t.pill.style.display = 'inline-flex';
    t.pill.style.left = r.left + 'px';
    t.pill.style.top = Math.max(0, r.top - 26) + 'px';
  }

  function repositionAll() { for (var i = 0; i < markers.length; i++) positionMarker(markers[i]); }

  function spliceFrom(arr, t) { var i = arr.indexOf(t); if (i >= 0) arr.splice(i, 1); }

  function dropMarker(t) {
    spliceFrom(tracked, t); spliceFrom(markers, t);
    if (t.box.parentNode) t.box.parentNode.removeChild(t.box);
    if (t.pill.parentNode) t.pill.parentNode.removeChild(t.pill);
    if (!tracked.length) stopPolling();
  }

  function setStatus(t, status, hasResult, auto) {
    if (t.done) return;
    var v = verbs(t.action);
    if (status === 'pending') {
      if (auto) {
        // A processor is attached — it will pick this up shortly. Keep the live spinner.
        if (t.mode !== 'queued') { t.mode = 'queued'; t.box.classList.remove('waiting'); spinnerPill(t, v.queued); }
      } else if (t.mode !== 'waiting') {
        // No processor — make it unmistakably "waiting on you", not "working". No spinner.
        t.mode = 'waiting';
        t.box.classList.add('waiting');
        t.pill.classList.add('waiting', 'mpo-clickable');
        t.pill.innerHTML = svgIcon(ICONS.clock, 12);
        var w = document.createElement('span'); w.textContent = 'queued — needs drain';
        t.pill.appendChild(w);
        t.pill.onclick = function () { toast(drainHint(t.action), TONE.warn); };
      }
      return;
    }
    if (status === 'processing') {
      if (t.mode !== 'processing') { t.mode = 'processing'; t.box.classList.remove('waiting'); spinnerPill(t, v.ing); }
    } else if (status === 'done') {
      t.done = true;
      t.mode = 'done';
      t.box.classList.remove('waiting');
      t.pill.classList.remove('waiting', 'mpo-clickable');
      t.pill.onclick = null;
      t.box.classList.add('done');
      t.pill.classList.add('done');
      t.pill.innerHTML = svgIcon(ICONS.check, 12);
      var c = document.createElement('span');
      if (hasResult) {
        c.textContent = v.done + ' — view';
        t.pill.appendChild(c);
        t.pill.classList.add('mpo-clickable');
        t.pill.addEventListener('click', function () { openResultPanel(t); });
        // keep the marker on screen until the doctor dismisses it
      } else {
        c.textContent = v.done;
        t.pill.appendChild(c);
        setTimeout(function () { fadeOut(t.box); fadeOut(t.pill); spliceFrom(markers, t); }, 1800);
      }
    }
  }

  function fadeOut(node) {
    node.style.transition = 'opacity .4s';
    node.style.opacity = '0';
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 420);
  }

  // Turn every "/medical-protocol:<skill>" mention in one text node into a clickable trigger chip.
  function skillChips(text) {
    var rx = new RegExp('/medical-protocol:[a-z][a-z0-9-]*', 'g');
    var frag = document.createDocumentFragment();
    var last = 0, m, hit = false;
    while ((m = rx.exec(text))) {
      hit = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'mpo-skill';
      b.setAttribute('data-skill', m[0]);
      b.title = 'Run ' + m[0] + ' on this selection';
      b.textContent = m[0];
      frag.appendChild(b);
      last = m.index + m[0].length;
    }
    if (!hit) return null;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  // Walk the rendered report's text nodes and linkify skill mentions — skipping code, links, and
  // existing chips so we never rewrite literal code samples or break markup.
  function linkifySkills(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [], n;
    while ((n = walker.nextNode())) {
      if (n.parentNode && n.parentNode.closest && n.parentNode.closest('code,pre,a,.mpo-skill')) continue;
      if (n.nodeValue.indexOf('/medical-protocol:') >= 0) nodes.push(n);
    }
    for (var i = 0; i < nodes.length; i++) {
      var frag = skillChips(nodes[i].nodeValue);
      if (frag && nodes[i].parentNode) nodes[i].parentNode.replaceChild(frag, nodes[i]);
    }
  }

  function openResultPanel(t) {
    panelOrder = t;
    var TITLE_VERB = { audit: 'Audit', add: 'Add', modify: 'Change', skill: 'Run', implement: 'Implement' };
    var titleVerb = TITLE_VERB[t.action] || 'Implement';
    panelTitle.textContent = titleVerb + ' — ' + (t.selector || t.file);
    panelBody.textContent = 'Loading…';
    panelApply.style.display = 'none';
    panel.style.display = 'flex';
    fetch(BASE + '/result?file=' + encodeURIComponent(t.file)).then(function (r) { return r.json(); }).then(function (d) {
      var res = d && d.result;
      if (!res) { panelBody.textContent = 'No result recorded for this selection.'; return; }
      var html = '';
      if (res.score) html += '<div class="mpo-score"><span class="mpo-score-k">SCORE</span>' + escapeHtml(String(res.score)) + '</div>';
      html += (res.report != null ? renderMarkdown(res.report) : '<pre><code>' + escapeHtml(JSON.stringify(res, null, 2)) + '</code></pre>');
      panelBody.innerHTML = html;
      linkifySkills(panelBody);
      renderSuggestions(res.suggestions);
      panelBody.scrollTop = 0;
      // Everything that writes files is STAGED until approved — offer "Apply" to land the diff from
      // here. Audit is the only action that never stages, because it never writes.
      if (d.action !== 'audit' && d.approved === false) {
        panelApply.disabled = false;
        panelApply.innerHTML = svgIcon(ICONS.check, 13) + '<span>Apply</span>';
        panelApply.style.display = 'inline-flex';
      }
    }).catch(function (err) { panelBody.textContent = 'Could not load result: ' + err.message; });
  }

  // Render the report's structured skill suggestions as a row of "Run" buttons under the report.
  function renderSuggestions(list) {
    if (!Array.isArray(list) || !list.length) return;
    var wrap = el('div', 'mpo-suggest');
    var head = el('div', 'mpo-suggest-head'); head.textContent = 'Suggested actions';
    wrap.appendChild(head);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !s.skill) continue;
      var b = el('button', 'mpo-suggest-btn'); b.type = 'button';
      b.setAttribute('data-skill', s.skill);
      if (s.prompt) b.setAttribute('data-prompt', s.prompt);
      b.title = 'Run ' + s.skill + ' on this selection';
      var sp = document.createElement('span'); sp.textContent = s.label || s.skill;
      b.innerHTML = svgIcon(ICONS.send, 12); b.appendChild(sp);
      wrap.appendChild(b);
    }
    panelBody.appendChild(wrap);
  }

  // Trigger a recommended skill against this same selection (POST /run). Records intent; with --auto
  // a headless run processes it. Re-uses the order's anchor server-side, so we only send the file ref.
  function runSkill(t, skill, prompt) {
    if (!t || !skill) return;
    toast('Triggering ' + skill + '…', TONE.info);
    fetch(BASE + '/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: t.file, skill: skill, prompt: prompt || null })
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (d) { throw new Error(d && d.error ? d.error : 'HTTP ' + r.status); });
      return r.json();
    }).then(function (d) {
      toast(d.auto ? 'Triggered ' + skill + ' — running headless…' : 'Queued ' + skill + ' — run the overlay queue in Claude Code to process it.', TONE.ok);
      if (d.file) track(d.file, t.selector, 'skill');
    }).catch(function (err) { toast('Trigger failed: ' + err.message, TONE.error); });
  }

  // Approve a staged add/implement order → the server re-queues it and (in --auto) the agent lands the diff.
  function applyOrder(t) {
    panelApply.disabled = true;
    panelApply.innerHTML = svgIcon(ICONS.check, 13) + '<span>Applying…</span>';
    fetch(BASE + '/approve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: t.file })
    }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'approve failed');
      toast(d.auto ? 'Approved — landing the staged diff…' : 'Approved — run the overlay skill in Claude Code to land it.', TONE.ok);
      reTrack(t);
      closePanel();
    }).catch(function (err) {
      panelApply.disabled = false;
      panelApply.innerHTML = svgIcon(ICONS.check, 13) + '<span>Apply</span>';
      toast('Apply failed: ' + err.message, TONE.error);
    });
  }

  // Re-arm a completed marker so it shows progress again while the approved diff is applied.
  function reTrack(t) {
    t.done = false;
    t.mode = 'init';
    t.box.classList.remove('done');
    t.pill.classList.remove('done', 'mpo-clickable');
    t.pill.innerHTML = '';
    var spin = el('span', 'mpo-spin');
    var lbl = document.createElement('span'); lbl.textContent = 'applying…';
    t.pill.appendChild(spin); t.pill.appendChild(lbl);
    t.label = lbl;
    if (tracked.indexOf(t) < 0) tracked.push(t);
    if (markers.indexOf(t) < 0) markers.push(t);
    positionMarker(t);
    startPolling();
  }

  function closePanel() { panel.style.display = 'none'; panelOrder = null; }

  function startPolling() { if (!pollTimer) pollTimer = setInterval(poll, 1200); }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function poll() {
    if (!tracked.length) { stopPolling(); return; }
    fetch(BASE + '/status').then(function (r) { return r.json(); }).then(function (data) {
      // /status returns { auto, orders }; tolerate the older bare-array shape too.
      var list = data && data.orders ? data.orders : (Array.isArray(data) ? data : []);
      var auto = !!(data && data.auto);
      var byFile = {};
      for (var i = 0; i < list.length; i++) byFile[list[i].file] = list[i];
      for (var j = tracked.length - 1; j >= 0; j--) {
        var t = tracked[j];
        var s = byFile[t.file];
        // missing from the queue = cleared after completion → treat as done (no result to show)
        setStatus(t, s ? s.status : 'done', s ? s.hasResult : false, auto);
        if (t.done) tracked.splice(j, 1);
      }
      repositionAll();
      if (!tracked.length) stopPolling();
    }).catch(function () { /* server down between polls — keep markers, retry next tick */ });
  }

  function copy(text) {
    if (navigator.clipboard) { navigator.clipboard.writeText(text); }
    toast('Copied selector', TONE.info);
  }

  function toast(msg, color) {
    var t = el('div', 'mpo-toast mpo-ui');
    var dot = el('span', 'mpo-dot');
    dot.style.color = color || TONE.info;
    var txt = document.createElement('span');
    txt.textContent = msg;
    t.appendChild(dot); t.appendChild(txt);
    document.body.appendChild(t);
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2800);
  }

  console.info('[medprotocol] overlay loaded — click "Protocol select" (bottom-right), hover any element, click to Audit, Implement, or Add a component. Server: ' + BASE);
})();
`;
