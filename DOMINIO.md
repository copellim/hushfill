# Concetti di dominio

Glossario dei concetti con cui Hushfill ragiona su un modulo, nell'ordine in cui un campo li attraversa: dal PDF alla casella compilata. Il comportamento visto dall'utente è in `README.md`; qui c'è cosa significa ogni termine e dove vive nel codice.

## Campo

Uno spazio del modulo in cui l'app può scrivere. Ce ne sono di due tipi (`source` in `src/form-fields.ts`):

- `acroform`: campo compilabile dichiarato nel PDF, con posizione, tipo e a volte un nome tecnico (`topmostSubform[0].Page1[0].f1_01[0]`) o un tooltip. Il PDF non dice cosa chiede il campo: lo dice il testo stampato intorno;
- `blank`: riga vuota di un modulo "da stampare" (`____`, puntini, linee disegnate), riconosciuta dall'app e compilata scrivendoci sopra.

## Etichetta ed estrazione

L'etichetta è il testo stampato sulla pagina che dice cosa scrivere nel campo: "Cognome", "C.A.P.", "Last name" sotto la riga. L'estrazione è il passo che la cerca: `describeSurroundings` in `src/field-labels.ts` guarda a sinistra, sopra e sotto il rettangolo e restituisce il testo con la sua posizione ("a sinistra: Gender", "sotto: (MM/DD/YYYY)"). Il riconoscimento toglie il prefisso di posizione prima del confronto.

Modi tipici in cui l'estrazione sbaglia:

- **didascalia sotto la riga**: nei moduli americani la didascalia è stampata sotto ("First name and middle initial"), e il testo sopra è la didascalia del campo precedente;
- **intestazione di colonna**: nelle tabelle l'etichetta è in cima alla colonna, lontana dalla cella, e resta fuori;
- **campo spostato**: il rettangolo dichiarato nel PDF non coincide con la casella disegnata (è sul bordo, o copre metà di due caselle), e il testo più vicino è quello della casella accanto.

Un errore di compilazione nasce quindi in uno di due punti: l'estrazione ha preso l'etichetta sbagliata, oppure l'etichetta era giusta e il riconoscimento l'ha abbinata male. Prima di correggere bisogna capire quale dei due.

## Profilo e intestazioni

Il profilo contiene i dati di una persona (`src/profiles.ts`). Le intestazioni sono le voci del profilo ("Nome", "Codice fiscale", "CAP"), ciascuna con un'etichetta e una descrizione facoltativa. Sono comuni a tutti i profili; ogni profilo ha i suoi valori e la sua firma.

- **intestazioni predefinite**: quelle con cui nasce il profilo. Per queste il riconoscimento sul computer ha esempi in `data/recognizer.json`. "Data di oggi" è calcolata, non salvata;
- **intestazioni personalizzate**: aggiunte dall'utente ("Numero patente"). Non hanno esempi: il riconoscimento le trova dalla sola etichetta dell'intestazione, e per questo è più facile che ne scelga una anche per campi che chiedono altro.

Un profilo può riguardare chiunque, non solo chi compila. Lo stesso modulo però mescola spesso persone diverse (il richiedente, un familiare, un delegato), e un campo come "Mother's birth surname" chiede un dato di una persona diversa da quella della sezione in cui si trova.

## Riconoscimento e decisione

Il riconoscimento decide, per ogni campo, quale dato del profilo ci va. Ci sono due motori, scelti in `src/recognition-engine.ts`:

- **sul computer** (`src/local-recognizer.ts`, predefinito): confronta l'etichetta con gli esempi e con le etichette delle intestazioni, per somiglianza a trigrammi. La conoscenza sta in `data/recognizer.json`, il codice è generico;
- **Jev** (`src/jev.ts`): servizio esterno a cui vanno solo le descrizioni dei campi e le intestazioni, mai i valori.

Entrambi producono una `FieldDecision` (`src/jev.ts`), il cui `target` è:

- l'id di un'intestazione;
- `insieme` (`COMBINED_CHOICE`): più intestazioni nello stesso campo ("Cognome e nome", "Luogo e data"), elencate in `parts` nell'ordine di scrittura;
- `firma` (`SIGNATURE_CHOICE`): spazio per la firma;
- `null`: nessuna, il campo non si compila dal profilo (protocolli, importi, motivi della richiesta, spazi riservati all'ufficio).

Le percentuali mostrate nella revisione sono somiglianze, non probabilità.

## Revisione

Prima di scrivere, l'utente vede le decisioni campo per campo e può correggerle. Un valore scritto in un campo riconosciuto ma vuoto nel profilo può essere salvato nel profilo; un valore scritto in un campo non riconosciuto può diventare una nuova intestazione, con un nome proposto dall'etichetta (`suggestHeadingLabel` in `src/profiles.ts`). La revisione non sa quale motore ha lavorato.
