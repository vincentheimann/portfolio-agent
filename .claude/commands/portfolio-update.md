---
description: Update PORTFOLIO.md and rebuild its PDF with a bounded token budget
argument-hint: <change list, one line per change: what to add, change or fill>
---

Update `PORTFOLIO.md` (or the `markdownFile` named in the portfolio tokens config) for the
changes given in `$ARGUMENTS`, then rebuild the PDF. Keep third person, the case-study format
and the voice defined in the portfolio agent spec (`.claude/agents/portfolio.md`). Run it in
a fresh session and apply the token economy below.

1. **Plan from anchors, not from reading.** Start with `grep -n '^## \|^### ' PORTFOLIO.md`
   and `grep -n` for each phrase you intend to touch. Never `cat`, never `sed -n` more than
   25 lines at a time, never `git diff` without `--stat` on this file.
2. **Edit with one anchored script.** Write a single Python script to the scratchpad that
   holds every edit as (old, new) pairs, asserts each anchor matches exactly once, and
   writes the file once. New prose exists only inside that script; never echo it back.
3. **Rebuild once**, after all edits:

   ```bash
   node .claude/agents/portfolio/build-portfolio-pdf.mjs --strip
   ```

   Before building, confirm the PDF is not open in a viewer (a locked file makes the build
   report success without writing; check the file timestamp after the build).
4. **Verify by text.** `pdftotext` piped to `grep -c` for the new phrases, plus the page
   count. Open a PDF page as an image only for a new diagram, at most one page.
5. **Report in six lines or fewer**: what changed, word and page counts, remaining `‹FILL›`
   count, and anything the owner must decide. No diff, no excerpts.

If the change list is longer than ten items or asks for a restructure, delegate the whole
run to the `portfolio` agent so the document never enters the main conversation. Do not
commit unless asked.
