/**
 * `POST /pipeline` and `POST /run` — the same handler, differing in who picks the profile.
 *
 * `/pipeline` is AUTOMATIC: it routes the input first and then runs whatever that chose.
 * `/run` is told which profile to use. They share everything after that decision, and sharing
 * it is the point — two endpoints that assembled their own run would be two answers to
 * "what did this input produce", and the run id would not tell them apart.
 *
 * The backend preflight is not optional politeness. A profile whose mode calls a model is
 * refused with 503 when its backend cannot be brought up, because a run that proceeds without
 * one produces a confident-looking failure attributed to the model rather than to the missing
 * server.
 */
import { randomUUID } from 'node:crypto'
import { route, type RouteResult } from '../../modes/router.ts'
import { runAgent } from '../../modes/agentic.ts'
import { runWorkflow, buildWorkflow } from '../../modes/workflow.ts'
import { nullTrace } from '../../core/trace.ts'
import { callsModel } from '../../core/config.ts'
import { withActivityScope, LLM_CALL_STAGE } from '../../core/activity.ts'
import { EXTRACT_STAGES } from '../../modes/extract.ts'
import { probeServer } from '../../core/client.ts'
import { ConfigError } from '../../core/config.ts'
import { PackError, type Pack } from '../../core/pack.ts'
import { ProfileError, type ProfileModule } from '../../core/profile.ts'
import { json } from '../reply.ts'
import type { RouteContext } from '../deps.ts'

export const runPipeline = async ({ req, res, url, reply, done, deps }: RouteContext): Promise<void> => {
      const body = (await deps.readBody(req)) as Record<string, unknown> | undefined
      const input = String(body?.input ?? '')
      const automatic = url.pathname === '/pipeline'
      let profileName = String(body?.profile ?? '')
      let pipelineRoute: RouteResult | undefined
      if (!automatic && !profileName) {
        reply.bad('profile is required')
        done(400)
        return
      }
      if (!input) {
        reply.bad('input is required')
        done(400)
        return
      }

      const runId = randomUUID()
      if (automatic) {
        if (!deps.cfg.pipeline) {
          reply.bad('no product pipeline is configured', { runId })
          done(400)
          return
        }
        const forcedWorkflow = typeof body?.workflow === 'string' ? body.workflow : undefined
        if (forcedWorkflow) {
          if (!deps.cfg.pipeline.workflows.includes(forcedWorkflow)) {
            reply.bad(`workflow '${forcedWorkflow}' is not in the pipeline catalogue`, { runId })
            done(400)
            return
          }
          pipelineRoute = { profile: forcedWorkflow, confidence: 1, reason: 'manual workflow override' }
        } else {
          const router = await deps.loadProfile(deps.cfg.pipeline.router)
          if (!router.profile.review) {
            reply.serverError(`pipeline router '${deps.cfg.pipeline.router}' exposes no review`, { runId })
            done(500)
            return
          }
          // A workflow router without a URL is deliberately rules-only. Supplying a URL
          // opts it into the same model fallback lifecycle as any other router profile.
          const routerUrl = router.config.url ? deps.backendFor(router.config.url as string) : undefined
          if (routerUrl) {
            const ready = await deps.manager.ensure(routerUrl)
            deps.backendReachability.set(routerUrl, ready)
            if (!ready) {
              reply.serviceUnavailable(
                `no model backend is reachable at ${routerUrl} — ${deps.manager.describe(routerUrl)}. ` +
                  'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
                { runId },
              )
              done(503)
              return
            }
            await deps.emitModelIdentified(routerUrl)
          }
          const review = await withActivityScope({ runId }, () => router.profile.review!({
            pack: undefined,
            baseUrl: routerUrl,
            trace: nullTrace(),
            input: { kind: 'text', text: input, label: 'pipeline-input' },
            options: {},
            provider: deps.provider,
            activity: deps.activity,
          }))
          if (!review.report || typeof review.report !== 'object') {
            reply.serverError(`pipeline router '${deps.cfg.pipeline.router}' produced no workflow route`, { runId })
            done(500)
            return
          }
          pipelineRoute = review.report as RouteResult
        }
        if (!deps.cfg.pipeline.workflows.includes(pipelineRoute.profile)) {
          reply.serverError(`pipeline router selected workflow '${pipelineRoute.profile}' outside its catalogue`, { runId })
          done(500)
          return
        }
        profileName = pipelineRoute.profile
        deps.activity.emit({
          kind: 'route.decided',
          runId,
          profile: profileName,
          confidence: pipelineRoute.confidence,
          reason: pipelineRoute.reason,
          ruleVsModel: pipelineRoute.reason.startsWith('model:') ? 'model' : 'rule',
        })
      }

      const { profile, config: profileConfig } = await deps.loadProfile(profileName)
      const pack = await deps.loadPackForProfile(profileName, profile, profileConfig)
      const baseUrl = profileConfig.url ? deps.backendFor(profileConfig.url as string) : undefined
      const options = (body?.options ?? {}) as Record<string, unknown>
      // `runId` is on the response for the same reason it is on every event this run
      // emits: it is the only key that ties the answer a caller holds to the feed that
      // explains how it was produced. A dashboard uses it to assemble the run's log.
      const respond = <T extends object>(result: T, output: unknown) => reply.ok(
        automatic
          ? { ...deps.runResult(result, output), runId, workflow: profileName, route: pipelineRoute }
          : { ...deps.runResult(result, output), runId },
      )

      // A run that would need a model can see the check coming: a backend that can never
      // answer the FIRST step would fail with a buried "cannot reach server" message and
      // the dashboard would read as "nothing happened". Refuse loudly instead. A router
      // run is rules-only and a workflow whose every step is a router runs on rules too,
      // so those keep working with no model at all. A backend the deps.manager can spawn is
      // brought up here rather than refused.
      const neededBackends = new Set<string>()
      const hasSteps = Array.isArray(profileConfig.steps) && profileConfig.steps.length > 0
      const needsModel = await (async (): Promise<boolean> => {
        const profileUrl = deps.backendFor(baseUrl)
        if (profile.mode === 'extract' || profile.mode === 'agentic') {
          neededBackends.add(profileUrl)
          return true
        }
        if (profile.mode !== 'workflow' || !hasSteps) return false
        for (const step of profileConfig.steps as Array<Record<string, unknown>>) {
          const stepName = String(step?.profile ?? '')
          if (!stepName) continue
          // Router steps run on compiled rules; only a step that might call a model
          // obligates a usable backend. Configs are cached, so this costs nothing.
          const stepEntry = await deps.loadProfile(stepName)
          if (callsModel(stepEntry.config.mode)) {
            neededBackends.add(deps.backendFor(stepEntry.config.url as string | undefined))
          }
        }
        return neededBackends.size > 0
      })()
      // A workflow's models are loaded ONE AT A TIME, at the step that needs each.
      //
      // Preflight used to start every step's backend before step 0 and hold them all for
      // the run. That is the wrong shape for the machine this product targets: a two-model
      // workflow then peaks at both sets of weights plus both KV caches, and the loads race
      // each other on the way up. Nothing about the recipe requires it — step 2 cannot run
      // until step 1 has finished, so its model is dead weight until then. `ensureBackend`
      // below brings each up at its turn, and a backend the budget needs room for is
      // evicted between steps rather than kept beside its successor.
      //
      // What preflight was RIGHT about is failing before the prompt is consumed, so that
      // survives as a check on the configuration rather than on the memory: a backend that
      // is neither reachable nor spawnable can never answer, and that is knowable now.
      const ensureOrExplain = async (needed: string): Promise<string | null> => {
        const ready = await deps.manager.ensure(needed)
        deps.backendReachability.set(needed, ready)
        return ready
          ? null
          : `no model backend is reachable at ${needed} — ${deps.manager.describe(needed)}. ` +
            'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.'
      }
      if (needsModel) {
        const isWorkflow = profile.mode === 'workflow' && hasSteps
        const unusable: string[] = []
        for (const needed of neededBackends) {
          // A single-profile run needs its one model now, so start it now — deferring it
          // would only move the same load a few lines later.
          if (!isWorkflow) {
            const problem = await ensureOrExplain(needed)
            if (problem) unusable.push(problem)
            continue
          }
          if (deps.manager.canSpawn(needed)) continue
          const reachable = await probeServer(needed)
          deps.backendReachability.set(needed, reachable)
          if (!reachable) {
            unusable.push(
              `no model backend is reachable at ${needed} — ${deps.manager.describe(needed)}. ` +
                'Start llama-server on it first (scripts/llama-server.sh), or check MEDEXTRACT_MANAGE_MODELS.',
            )
          }
        }
        if (unusable[0]) {
          reply.serviceUnavailable(unusable[0], { runId })
          done(503)
          return
        }
      }

      await deps.emitModelIdentified(baseUrl)

      return withActivityScope({ runId }, async () => {
        deps.activity.emit({
          kind: 'run.started',
          profile: profileName,
          inputChars: input.length,
          inputDigest: deps.inputDigest(input),
        })

        const runStartedAt = performance.now()

        try {
          // Extract / router / code — one review call, three declared shapes.
          if (profile.mode === 'extract' || profile.mode === 'router' || profile.mode === 'code') {
            if (!profile.review) {
              reply.serverError(`profile '${profileName}' has no review implementation`, { runId })
              done(500)
              return
            }
            const result = await profile.review({
              pack,
              baseUrl,
              trace: nullTrace(),
              input: { kind: 'text', text: input, label: 'server-input' },
              options,
              provider: deps.provider,
              activity: deps.activity,
            })
            deps.activity.emit({
              kind: 'run.completed',
              profile: profileName,
              wallMs: performance.now() - runStartedAt,
            })
            respond(result, result.report ?? result.raw ?? result.text)
            done(200)
            return
          }

          // Agentic
          if (profile.mode === 'agentic') {
            if (!profile.tools) {
              reply.serverError(`profile '${profileName}' declares no tools`, { runId })
              done(500)
              return
            }
            const result = await runAgent({
              systemPrompt: profile.systemPrompt ?? '',
              task: input,
              workspace: String(options.workspace ?? '/tmp'),
              tools: profile.tools,
              maxIterations: Number(options.iterations ?? profile.maxIterations ?? 12),
              baseUrl,
              trace: nullTrace(),
              provider: deps.provider,
              activity: deps.activity,
            })
            deps.activity.emit({
              kind: 'run.completed',
              profile: profileName,
              wallMs: performance.now() - runStartedAt,
            })
            respond(result, result.answer ?? result.error ?? result)
            done(200)
            return
          }

          // Workflow
          if (profile.mode === 'workflow') {
            const steps = profileConfig.steps as Array<Record<string, unknown>> | undefined
            if (!steps || !Array.isArray(steps)) {
              reply.serverError(`profile '${profileName}' has no 'steps' array in its config`, { runId })
              done(500)
              return
            }

            const workflowSteps = buildWorkflow(
              steps.map((s) => ({
                name: String(s.name ?? 'unnamed'),
                profile: String(s.profile ?? ''),
                input: s.input as string | Record<string, string> | undefined,
                field: s.field as string | undefined,
                options: s.options as Record<string, unknown> | undefined,
                final: s.final === true,
              })),
            )

            const profiles = new Map<string, ProfileModule>()
            const packs = new Map<string, Pack | undefined>()
            const baseUrls = new Map<string, string | undefined>()

            for (const step of workflowSteps) {
              if (!profiles.has(step.profile)) {
                const stepProfile = await deps.loadProfile(step.profile)
                profiles.set(step.profile, stepProfile.profile)
                baseUrls.set(step.profile, stepProfile.config.url)
                if (stepProfile.profile.needsPack || stepProfile.config.pack) {
                  const stepPack = await deps.loadPackForProfile(step.profile, stepProfile.profile, stepProfile.config)
                  packs.set(step.profile, stepPack)
                } else {
                  packs.set(step.profile, undefined)
                }
              }
            }

            profiles.set(profileName, profile)
            packs.set(profileName, pack)
            baseUrls.set(profileName, baseUrl)

            // Each step's model comes up at that step, and no sooner. No reservation is
            // needed to protect a later backend from the idle sweep any more, because a
            // later backend is not running yet: the thing the reservation defended
            // against — a long step 1 letting step 2's model be reclaimed out from under
            // it — cannot happen to a model that has not been loaded.
            const result = await runWorkflow({
              initialInput: input,
              steps: workflowSteps,
              profiles,
              packs,
              baseUrls,
              trace: nullTrace(),
              contextDir: options.contextDir as string | undefined,
              runStep: options.step !== undefined ? Number(options.step) : undefined,
              provider: deps.provider,
              activity: deps.activity,
              ensureBackend: async (stepBaseUrl) => ensureOrExplain(deps.backendFor(stepBaseUrl)),
            })
            deps.activity.emit({
              kind: 'run.completed',
              profile: profileName,
              wallMs: performance.now() - runStartedAt,
            })
            // The run's ending, named rather than left for a client to sniff out of the
            // step list. A workflow with a terminal step has written the one part of the
            // response meant for a person to read, and a client should not have to guess
            // which step that was — nor fall back to shape-matching a report.
            const terminalIndex = workflowSteps.findIndex((step) => step.final)
            const ending = terminalIndex === -1
              ? undefined
              : result.steps.find((step) => step.step === terminalIndex)?.text
            respond({ ...result, ending }, result.final)
            done(200)
            return
          }

          reply.serverError(`mode '${profile.mode}' is not supported by the server`, { runId })
          done(500)
        } catch (e) {
          deps.activity.emit({
            kind: 'run.failed',
            profile: profileName,
            wallMs: performance.now() - runStartedAt,
            error: (e as Error).message,
          })
          // Answered here rather than rethrown to the generic handler: that handler knows
          // the request but not the run, so its response could not name the run id the
          // caller needs to read the feed. The console line is kept for the operator.
          console.error(`Run ${runId} (${profileName}) failed:`, e)
          const status = e instanceof ConfigError || e instanceof PackError || e instanceof ProfileError ? 400 : 500
          json(res, status, { error: (e as Error).message, runId, profile: profileName }, reply.cors)
          done(status)
          return
        }
      })
}
