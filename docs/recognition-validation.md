# Validation of field recognition (to do)

A plan set aside: today recognition is tested only with the fake Jev of the
end-to-end tests, which answers by keywords and does not measure the model.
What is needed is a set of forms with the expected answer for each field, to
run with the real Jev and count right, wrong and unrecognised.

## What is measured

For each field of a form (AcroForm or blank line) the expected choice, among
the profile's default headings:

- a heading ("Codice fiscale", tax code; "Comune di residenza", town of
  residence; "Data di oggi", today's date);
- a combined field with its parts in order ("Nome + Cognome", first name +
  surname; "Comune di residenza + Data di oggi");
- "signature";
- "none", for fields that do not concern the person filling in the form:
  third-party data (a child, a company, an organisation), notes, reference
  numbers.

Metrics: accuracy per field; for combined fields, right parts and right order
counted separately; how many proposals above 0.5 are wrong (they are the ones
the review ticks on its own, the most dangerous); how many below 0.5 were
right.

## Main set: real forms

20-30 blank, public Italian forms (municipalities, INPS, Agenzia delle Entrate,
universities, schools): self-declarations, proxies, enrolments, release forms.
They must cover AcroForm, lines of characters (`____`, `....`), drawn lines,
labels above and below the line, "Luogo e data" (place and date), signature,
third-party fields.

For each form, a file next to the PDF with the expected answer per field,
written by hand and double-checked. The field is identified by page and
extracted label (`label`), not by index, so it holds up to small changes in
extraction.

A script runs extraction (`collectFormFields`) and the requests to Jev as
"Compila" (Fill) does, without the interface, compares with the expected
answer and prints a summary per form and in total. It is to be run by hand:
each run is one paid call per form, plus one for the combined fields.

No public dataset contains the typical cases of Italian forms ("Il/La
sottoscritto/a", the undersigned; "Luogo e data"; a child's data next to the
parent's): for this reason the main set stays handmade.

## Secondary set: XFUND and FUNSD

[XFUND](https://arxiv.org/pdf/2104.08836.pdf) (Microsoft, ACL Findings 2022)
is a set of forms in 7 languages, Italian included, annotated by hand: each
block of text is marked as header, question (the printed key, for
example "Luogo di nascita", place of birth) or answer, with the key → value
link. Original repository `github.com/doc-analysis/XFUND`; a copy with the
Italian part separated (train and validation) is on Hugging Face,
`FrancophonIA/XFUND`. For English there is FUNSD, from which XFUND derives and
which has the same format (format and licence to be checked before using it).

How it is used: the JSON already has the text and position of each block, so
the keys become directly the field descriptions to send to Jev, without going
through the images or the extraction from the PDF. The expected answer in our
terms is missing: for a sample of keys the corresponding profile heading, or
"none", has to be written by hand. The forms are of every kind, not only
personal-details ones, so many keys end up as "none": that is exactly what it
is for, measuring how many wrong proposals above 0.5 come out on fields that
do not concern the profile. Only the keys go to Jev, never the values written
in the forms, as in the app.

Licence: CC BY-NC-SA 4.0 according to the copy on Hugging Face, to be
rechecked against the LICENSE file of the original repository. Local use for
validation is fine; the data is not copied into the repository.

## For blank lines: CommonForms

[CommonForms](https://arxiv.org/pdf/2509.16506) (WACV 2026) collects about
55k PDFs with fillable fields taken from Common Crawl, a third of the pages not
in English. It annotates only the position and type of the field (text, box,
signature), not which information it asks for: it does not measure
recognition, but it can measure the extraction of blank lines
(`src/drawn-lines.ts`, `src/form-fields.ts`) by removing the AcroForm fields
and comparing the lines found with the annotated boxes, and the "signature"
choice. A later benchmark
([Mind the Gaps](https://arxiv.org/pdf/2609.23679)) reports inconsistent
annotations and wrong boxes: disagreements must be looked at by hand before
counting them as errors. Data and licence at `github.com/jbarrow/commonforms`,
to be verified.

## Discarded

Datasets of personal data in free text (NER), such as
[ai4privacy pii-masking](https://huggingface.co/datasets/ai4privacy/pii-masking-300k)
in Italian and English: they are prose texts with the entities marked, not
forms, and the label does not say whose data it is. Restrictive licences (CC
BY-NC 4.0 for the 200k version, "other" for 300k and 400k).
