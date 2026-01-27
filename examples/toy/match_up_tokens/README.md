# Match Up Tokens Example

This example demonstrates a Petri net that matches strings to integers representing their lengths.

## How it works

**Initial state:**
- `Some Strings` place: `["a", "ab", "abc", "abcd"]`
- `Some Lengths` place: `[2, 3, 4, 5, 99]`
- `Matched Pair` place: `[]` (empty)

**Transition behavior:**
- The `Match Lengths` transition takes all tokens from both input places
- It searches for a string whose length matches one of the integers
- When found, it outputs:
  - Unmatched strings back to `Some Strings`
  - Unmatched integers back to `Some Lengths`
  - The matched pair to `Matched Pair`

**Expected execution:**
1. First fire: Match "ab" (length 2) with 2 → outputs `("ab", 2)`
2. Second fire: Match "abc" (length 3) with 3 → outputs `("abc", 3)`
3. Third fire: Match "abcd" (length 4) with 4 → outputs `("abcd", 4)`
4. Fourth fire: No match for "a" (length 1) or remaining lengths (5, 99) → fails

## Running the example

```bash
uv run streamlit run examples/toy/match_up_tokens/app.py
```

## Key concepts demonstrated

- **Output distribution function**: Routes different parts of the result to different places
- **Token circulation**: Unmatched tokens flow back to their original places
- **Accumulation**: Matched pairs accumulate in the output place
- **Termination**: The net naturally stops when no more matches can be found
