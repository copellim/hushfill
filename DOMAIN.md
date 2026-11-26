# Domain concepts

Glossary of the concepts Hushfill uses to reason about a form, in the order a field goes through them: from the PDF to the filled-in box. The behaviour as the user sees it is in `README.md`; here is what each term means and where it lives in the code.

## Field

A space on the form where the app can write. There are two kinds (`source` in `src/form-fields.ts`):

- `acroform`: a fillable field declared in the PDF, with position, type and sometimes a technical name (`topmostSubform[0].Page1[0].f1_01[0]`) or a tooltip. The PDF does not say what the field asks for: the text printed around it does;
- `blank`: a blank line of a print-and-fill form (`____`, dots, drawn lines), recognised by the app and filled by writing over it.

## Label and extraction

The label is the text printed on the page that says what to write in the field: "Cognome" (surname), "C.A.P." (postcode), "Last name" under the line. Extraction is the step that looks for it: `describeSurroundings` in `src/field-labels.ts` looks to the left of, above and below the rectangle and returns the text with its position ("a sinistra: Gender", to the left; "sotto: (MM/DD/YYYY)", below). Recognition strips the position prefix before comparing.

Typical ways extraction goes wrong:

- **caption under the line**: on American forms the caption is printed below ("First name and middle initial"), and the text above is the caption of the previous field;
- **column heading**: in tables the label is at the top of the column, far from the cell, and is left out;
- **shifted field**: the rectangle declared in the PDF does not match the drawn box (it sits on the border, or covers half of two boxes), and the nearest text is that of the neighbouring box.

A filling error therefore starts at one of two points: extraction picked the wrong label, or the label was right and recognition matched it wrongly. Before fixing, you need to understand which of the two.

## Profile and headings

The profile holds one person's data (`src/profiles.ts`). The headings are the profile's entries ("Nome" (first name), "Codice fiscale" (tax code), "CAP" (postcode)), each with a label and an optional description. They are shared by all profiles; each profile has its own values and its own signature.

- **default headings**: those the profile is created with. For these, recognition on the computer has examples in `data/recognizer.json`. "Data di oggi" (today's date) is computed, not saved;
- **custom headings**: added by the user ("Numero patente", driving licence number). They have no examples: recognition finds them from the heading's label alone, and for this reason it is more likely to pick one even for fields that ask for something else.

A profile can be about anyone, not only the person filling in the form. The same form, however, often mixes different people (the applicant, a family member, a delegate), and a field like "Mother's birth surname" asks for data about a person other than the one of the section it sits in.

## Recognition and decision

Recognition decides, for each field, which profile data goes into it. There are two engines, chosen in `src/recognition-engine.ts`:

- **on the computer** (`src/local-recognizer.ts`, the default): compares the label with the examples and with the heading labels, by trigram similarity. The knowledge lives in `data/recognizer.json`, the code is generic;
- **Jev** (`src/jev.ts`): an external service that receives only the field descriptions and the headings, never the values.

Both produce a `FieldDecision` (`src/jev.ts`), whose `target` is:

- the id of a heading;
- `insieme` (together, `COMBINED_CHOICE`): several headings in the same field ("Cognome e nome", surname and name; "Luogo e data", place and date), listed in `parts` in writing order;
- `firma` (signature, `SIGNATURE_CHOICE`): space for the signature;
- `null`: none, the field is not filled from the profile (reference numbers, amounts, reasons for the request, spaces reserved for the office).

The percentages shown in the review are similarities, not probabilities.

## Review

Before writing, the user sees the decisions field by field and can correct them. A value typed into a field that was recognised but is empty in the profile can be saved to the profile; a value typed into an unrecognised field can become a new heading, with a name suggested from the label (`suggestHeadingLabel` in `src/profiles.ts`). The review does not know which engine did the work.
