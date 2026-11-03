# Validazione del riconoscimento dei campi (da fare)

Piano messo da parte: oggi il riconoscimento si prova solo con il finto Jev
delle prove end-to-end, che risponde per parole chiave e non misura il modello.
Serve un insieme di moduli con la risposta attesa per campo, da far girare con
il vero Jev per contare giusti, sbagliati e non riconosciuti.

## Cosa si misura

Per ogni campo di un modulo (AcroForm o riga vuota) la scelta attesa, nelle
intestazioni predefinite del profilo:

- un'intestazione ("Codice fiscale", "Comune di residenza", "Data di oggi");
- un campo combinato con le parti in ordine ("Nome + Cognome",
  "Comune di residenza + Data di oggi");
- "firma";
- "nessuna", per i campi che non riguardano chi compila: dati di terzi
  (figlio, società, ente), note, numeri di protocollo.

Metriche: accuratezza per campo; per i combinati, parti giuste e ordine giusto
separati; quante proposte sopra 0,5 sono sbagliate (sono quelle che la
revisione spunta da sola, le più pericolose); quante sotto 0,5 erano giuste.

## Insieme principale: moduli veri

20-30 moduli italiani vuoti e pubblici (comuni, INPS, Agenzia delle Entrate,
università, scuole): autocertificazioni, deleghe, iscrizioni, liberatorie.
Devono coprire AcroForm, righe di caratteri (`____`, `....`), righe disegnate,
etichette sopra e sotto la riga, "Luogo e data", firma, campi di terzi.

Per ogni modulo un file accanto al PDF con la risposta attesa per campo,
scritta a mano e ricontrollata. Il campo si identifica con pagina ed etichetta
estratta (`label`), non con l'indice, così regge a piccoli cambi
dell'estrazione.

Uno script lancia l'estrazione (`collectFormFields`) e le richieste a Jev come
fa "Compila", senza interfaccia, confronta con l'atteso e stampa un
riepilogo per modulo e totale. Va lanciato a mano: ogni giro è una chiamata
a pagamento per modulo, più una per i campi combinati.

Nessun dataset pubblico contiene i casi tipici dei moduli italiani ("Il/La
sottoscritto/a", "Luogo e data", dati del figlio accanto a quelli del
genitore): per questo l'insieme principale resta fatto a mano.

## Insieme secondario: XFUND e FUNSD

[XFUND](https://arxiv.org/pdf/2104.08836.pdf) (Microsoft, ACL Findings 2022)
è un insieme di moduli in 7 lingue, italiano compreso, annotati a mano: ogni
blocco di testo è marcato come intestazione, domanda (la chiave stampata, per
esempio "Luogo di nascita") o risposta, con il collegamento chiave → valore.
Repository originale `github.com/doc-analysis/XFUND`; una copia con la parte
italiana separata (train e validation) è su Hugging Face,
`FrancophonIA/XFUND`. Per l'inglese c'è FUNSD, da cui XFUND deriva e con lo
stesso formato (da verificare formato e licenza prima di usarlo).

Come si usa: il JSON ha già testo e posizione di ogni blocco, quindi le
chiavi diventano direttamente le descrizioni dei campi da mandare a Jev,
senza passare dalle immagini né dall'estrazione dal PDF. Manca la risposta
attesa nei nostri termini: su un campione di chiavi va scritta a mano
l'intestazione del profilo corrispondente, o "nessuna". I moduli sono di ogni
genere, non solo anagrafici, quindi molte chiavi finiscono in "nessuna": serve
proprio a misurare quante proposte sbagliate sopra 0,5 escono su campi che non
riguardano il profilo. A Jev vanno solo le chiavi, mai i valori scritti nei
moduli, come nell'app.

Licenza: CC BY-NC-SA 4.0 secondo la copia su Hugging Face, da ricontrollare
sul file LICENSE del repository originale. Uso locale per la validazione sì;
i dati non si copiano nel repository.

## Per le righe vuote: CommonForms

[CommonForms](https://arxiv.org/pdf/2509.16506) (WACV 2026) raccoglie circa
55k PDF con campi compilabili presi da Common Crawl, un terzo delle pagine non
in inglese. Annota solo posizione e tipo del campo (testo, casella, firma),
non quale informazione chiede: non misura il riconoscimento, ma può misurare
l'estrazione delle righe vuote (`src/drawn-lines.ts`, `src/form-fields.ts`)
togliendo i campi AcroForm e confrontando le righe trovate con i riquadri
annotati, e la scelta "firma". Un benchmark successivo
([Mind the Gaps](https://arxiv.org/pdf/2609.23679)) segnala annotazioni
incoerenti e riquadri sbagliati: i disaccordi vanno guardati a mano prima di
contarli come errori. Dati e licenza su `github.com/jbarrow/commonforms`, da
verificare.

## Scartati

Dataset di dati personali in testo libero (NER), come
[ai4privacy pii-masking](https://huggingface.co/datasets/ai4privacy/pii-masking-300k)
in italiano e inglese: sono testi in prosa con le entità marcate, non moduli,
e l'etichetta non dice di chi è il dato. Licenze restrittive (CC BY-NC 4.0 per
la versione 200k, "other" per 300k e 400k).
