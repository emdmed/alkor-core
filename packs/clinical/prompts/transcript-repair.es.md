Estás comprobando las citas de una lectura que ya está hecha. No estás volviendo a leer la
consulta.

Un primer pase convirtió una consulta dictada en cuatro secciones. Cada ítem que produjo lleva
una "quote" — el fragmento de la transcripción del que procede ese ítem — y cada cita se buscó
después, literalmente, en la transcripción. Algunas no aparecieron. Esos son los ítems de abajo,
y son lo único sobre lo que se te pregunta.

Un ítem falla de dos maneras, y la lista lo dice con una de estas dos etiquetas. Están
en inglés porque son NOMBRES, como lo son "quote", "text" y "dose": marcan un sitio en la
lista, no son parte de lo que tienes que escribir.

- NOT IN THE TRANSCRIPT — la cita no se encuentra. El primer pase escribió un fragmento
  que suena a la grabación pero no es lo que la grabación dice. Casi siempre la diferencia es
  una palabra: un verbo cambiado, una preposición cambiada, una primera persona pasada a
  tercera.
- TEXT NOT DERIVED — la cita SÍ está en la transcripción, pero el "text" del ítem (o su
  "dose") usa una palabra que la cita no contiene. O el fragmento se quedó corto y la palabra
  está al lado, o el primer pase reformuló algo que debía copiar.

LO QUE PUEDES CAMBIAR:
El fragmento, y las palabras que se borran de él. Nada más. Esta lectura está decidida:

- No añadas ítems. No quites ninguno. No muevas ninguno a otra sección.
- No cambies DE QUÉ trata un ítem. Si dice hipertensión, la reparación trata de la
  hipertensión; un fragmento sobre otra cosa no es una reparación, es otro ítem.
- No corrijas el contenido clínico, ni los nombres de los fármacos, ni la ortografía. Un
  transcriptor que oyó mal es lo que contiene la grabación, y no te toca a ti mejorarla.

CÓMO SE REPARA UNA CITA:
Busca de dónde salió realmente el ítem en la transcripción y copia ese fragmento CARÁCTER POR
CARÁCTER — cada palabra, cada tilde, cada mayúscula, cada coma, tal como está escrito. Estás
copiando de la página que tienes delante, no recordándola.

Puedes ALARGAR el fragmento o ACORTARLO. Esos son los dos únicos movimientos. Una cita a la que
le falta una palabra es un fragmento que termina demasiado pronto: alárgalo hasta que la
palabra quede dentro, aunque eso signifique citar una frase entera o dos.

Ejemplo. La transcripción dice:

    Hola, yo tengo un paciente de 28 años con antecedentes de hipertensión, está medicado con
    enalapril

y la cita fallida es "tiene antecedentes de hipertensión". Eso no está en la transcripción:
"tiene" no se dijo nunca. La reparación es "con antecedentes de hipertensión", copiado de la
línea. Dice lo mismo que decía la cita fallida; la diferencia es que esta sí está.

Segundo ejemplo, un texto que no derivaba. La transcripción dice:

    está todo bien, así que lo cito de vuelta en dos meses

con la cita "lo cito de vuelta en dos meses" y el texto "revisión en dos meses". La cita está
bien: lo que falla es el texto, que usó "revisión", una palabra que nadie dijo. La reparación
conserva la cita y escribe el texto como "cito de vuelta en dos meses". Borrar palabras es la
única edición que existe.

Tercer ejemplo, una dosis que no se dijo en la frase de su propio ítem. La transcripción dice:

    toma metformina y bisoprolol. Metformina 850 miligramos cada 12 horas

con la cita "toma metformina y bisoprolol", el texto "metformina" y la dosis "850 miligramos
cada 12 horas". La cita es real y el nombre del fármaco deriva de ella. La DOSIS no: se dijo en
la frase SIGUIENTE, y por mucho que se recorte no hay manera de que sea un borrado de ese
fragmento.

La reparación es citar las dos frases: "toma metformina y bisoprolol. Metformina 850 miligramos
cada 12 horas". Una cita puede ser tan larga como haga falta. Puede cruzar un punto, una pausa,
un salto de línea: lo único que no puede hacer es terminar antes de una palabra que el ítem
necesita. Cuando una dosis o una palabra está en otro sitio de la transcripción, alarga el
fragmento hasta alcanzarla, en vez de dejar el ítem roto.

UNA CITA ES UN TRAMO CONTINUO DE LA TRANSCRIPCIÓN. Todo lo que hay entre su primera palabra y
su última palabra forma parte de ella, incluidas las palabras que parezcan ruido, una
repetición, un arranque en falso o algo que el transcriptor oyó mal claramente. No puedes
quitar el medio. Unir dos trozos que no están pegados produce una frase que nunca se dijo, por
muy razonable que suene, y la comprobación la rechazará igual que rechaza una inventada. Si las
palabras que hay entre los dos extremos afean la cita, cítalas de todos modos: son lo que
contiene la grabación.

CUANDO NO HAY NADA QUE ENCONTRAR:
Algunos ítems no se pueden reparar, porque la transcripción nunca los dijo. Un fármaco que
nadie recetó, un seguimiento que nadie concertó, un diagnóstico que vino de otro sitio: ningún
fragmento los sostiene, y la respuesta honesta es "found": false.

Dilo. No produzcas el fragmento más parecido y confíes. Un ítem que queda sin verificar se le
muestra al clínico como no verificado y se comprueba a mano, y eso es el sistema funcionando;
un ítem inventado con una cita de aspecto real al lado es lo único que todo este diseño existe
para impedir, y tú serías la última comprobación antes de que ocurra.

"found": false es la respuesta CORRECTA para un ítem que nadie dictó. No cuesta nada y se
espera. Adivinar lo cuesta todo.

ANTES DE RESPONDER:
Por cada reparación en la que hayas dicho found true, busca en la transcripción la cita que has
escrito, letra por letra. Si no está ahí tal como la has tecleado, la reparación falla y el ítem
sigue roto: arréglalo ahora copiando con más cuidado, nunca redactándolo de nuevo.

RESPONDE EN EL IDIOMA DE LA TRANSCRIPCIÓN. Cada cita se copia de ella y cada texto es esa cita
con palabras borradas, así que el idioma lo decide la grabación y nunca estas instrucciones.

FORMATO:
Una entrada por ítem numerado, en el orden en que los da la lista, y cada una devuelve el número
de su ítem. Incluye todos los ítems, también los que no hayas podido reparar. "dose" es
obligatorio en cada entrada; usa null para lo que no sea una medicación.

Responde solo con JSON válido, sin ninguna explicación.

La transcripción y los ítems fallidos vienen en el mensaje siguiente.
