My name is Stephen Tioluwani, I am a fulltime founder, and I like to build and iw nat us t have a good and fun time building and architecting solutions together

I love talking, so assume every prompt as a talk/research unless i explicitly tell u to start coding

I'd love it if you study the repository before writing new code. Understand how the existing system solves the problem, then follow its established patterns. Prefer reusing or extending existing functions, components, utilities, types, and logic over creating duplicates. For UI, reuse existing components and composition patterns instead of rebuilding the same behavior from scratch. Don't introduce a new abstraction or pattern until you've checked that the repository doesn't already have a suitable one.

write typescript the way matt pocock will be proud of you.
I also listed somethings below for you:


### 1. Performance
- Atomic updates
- Minimize CPU usage
- Minimize time-to-visible-change
- Measure CPU cost of important operations
- Measure latency from action → UI update
- Avoid unnecessary renders
- Avoid unnecessary network requests
- Prefer incremental computation over recomputing everything
- Benchmark before and after performance-sensitive changes

### 2. UI / State
- Optimistic UI by default where rollback is possible
- UI should respond immediately to user actions
- Background synchronization
- Reconcile optimistic state with server state
- Handle conflicts explicitly
- Realtime updates where they provide actual value
- Subscriptions should be scoped and cleaned up
- Don't make the UI wait for the network unnecessarily

### 3. React
- Keep components small
- Keep state as close as possible to where it is used
- Avoid unnecessary global state
- Derive state instead of duplicating it
- Avoid unnecessary effects
- Effects should synchronize with external systems, not orchestrate application logic
- Stable identities where they actually matter
- Don't memoize blindly; measure first

### 4. TypeScript
This should probably be one of the strongest sections.

- `any` is not allowed
- `as` should be rare and justified
- No `@ts-ignore`
- No `@ts-expect-error` without an explanation
- Prefer narrowing over assertions
- Prefer discriminated unions
- Model impossible states as impossible
- Use branded types for values that must not be interchangeable
- Infer types where inference is clear
- Explicitly type public APIs and boundaries
- Runtime validation at external boundaries
- Types should represent actual domain constraints
- Don't weaken types to make the compiler stop complaining

### 5. Testing
Not just “write tests.”

- Test behavior, not implementation details
- Tests should measure meaningful performance characteristics
- Measure CPU usage for CPU-sensitive operations
- Measure latency for user-visible operations
- Test optimistic updates
- Test rollback/reconciliation
- Test realtime synchronization
- Test concurrent updates
- Test offline/background-sync behavior
- Performance regressions should be detectable in CI where practical

### 6. Data / Realtime
- Server state and client state have different responsibilities
- Prefer realtime subscriptions over polling when appropriate
- Updates should be granular
- Don't refetch entire datasets when one record changed
- Sync only what changed
- Design for reconnects
- Design for duplicate/out-of-order events
- Treat synchronization as a consistency problem, not just a networking problem

### 7. Code Quality
- Small functions
- Small modules
- Clear names
- One responsibility per unit
- Avoid abstractions until the duplication/problem is real
- Delete dead code
- Prefer straightforward code over clever code
- Don't hide expensive operations behind innocent-looking APIs
- Errors should be explicit and actionable

### 8. Architecture
- Optimize for the actual bottleneck
- Keep boundaries explicit
- Minimize unnecessary coupling
- Prefer local changes over cascading changes
- Make dependencies obvious
- Keep infrastructure concerns out of domain logic
- Design APIs around capabilities rather than implementation details

### 9. Engineering Workflow
- Make small, atomic changes
- Each change should be independently understandable
- Run tests before and after meaningful changes
- Measure before optimizing
- Profile instead of guessing
- Keep diffs small
- Don't mix refactoring with behavioral changes unless necessary
- Remove temporary code after the change is complete

### 10. Things I Don't Do
This section would make the repo feel much more **you**.

For example:

- I don't use `any` to silence TypeScript.
- I don't add abstractions just because they look reusable.
- I don't make the UI wait for a server round trip when it doesn't need to.
- I don't poll when realtime synchronization is appropriate.
- I don't optimize based on guesses.
- I don't accept performance regressions without measuring them.
- I don't write tests that only prove implementation details.
- I don't make large changes when a small atomic change will do.

And I'd add one overarching principle at the top:

> **Make the smallest change that produces the desired behavior, make it immediately visible to the user, synchronize it correctly in the background, and measure the cost.**

Hard limits for manual code:

- file under 500 lines;
- pure function at most 50 lines;
- React component at most 150 lines;
- component hooks/state section at most 50 lines;
- custom hook at most 75 lines;
- cyclomatic complexity at most 10;
- cognitive complexity at most 25.


Before opening a PR:
Run fallow and make sure it passes.


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
