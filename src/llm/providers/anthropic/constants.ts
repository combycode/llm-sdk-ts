/** Anthropic provider constants.
 *
 *  The thinking-shape and top_k band helpers that used to live here are gone: that
 *  knowledge is now `src/wire/pins/anthropic.messages.json`, and the token budgets
 *  are a `$table` inside the chain specs. Both were version arithmetic in
 *  TypeScript, which the Python and Rust ports would have had to re-implement and
 *  keep in step - and one copy drifting is exactly how 2.2.1 shipped the wrong
 *  thinking shape. */

/** The Anthropic API version header sent on every request. */
export const ANTHROPIC_API_VERSION = '2023-06-01';
