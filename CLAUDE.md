# CLAUDE.md — Web Traffic Speedometer

## Project Overview
This repository measures web network performance (latency, throughput, state) and maps raw network metrics (`ip6`, `udp`, `web`, `dns`) into deterministic activity grades (e.g., `voice`, `news`).

---

## 1. Test Suite Specifications
All tests must strictly define explicit functional contracts.

* **Naming Syntax:** Test descriptions MUST follow the format:  
  `"<target/function> MUST <expected behavior> WHEN <condition>"`  
  *(Example: `gradeActivities MUST return identical grades WHEN called repeatedly with identical round data`)*
* **Prohibited Words:** NEVER use anthropomorphic or narrative terms (`consults`, `knows`, `thinks`, `remembers`, `decides`, `asks`) or negative abstractions (`nothing does X`).
* **Assertions:** Test single behaviors per block. Assert exact return values, pure function behavior, and state immutability.

---

## 2. Measurement & Domain Invariants
When writing or refactoring speed, latency, or connection code:

* **Monotonic Timing:** Use `performance.now()` for all time delta ($\Delta t$) calculations. Never use `Date.now()` or wall-clock timestamps for speed or latency metrics.
* **Pure Grading Functions:** Functions like `gradeActivities()` must remain 100% pure, stateless, and idempotent. Inputs map to outputs with zero side-effects or historical session dependence.
* **Boundary Guarding:**
  * Prevent division by zero or near-zero $\Delta t$.
  * Handle zero-traffic intervals explicitly—never equate zero byte transfer with an offline network state without active probe confirmation.
  * Clamp or sanitize negative byte deltas caused by resets or socket reconnections.
* **Unit Precision:** Keep scale conversion explicit (`Bytes` vs `Bits`, base-10 network throughput vs base-2 memory allocations).

---

## 3. Code & Comment Style
Maintain a dry, system-level documentation style across all files.

* **No Conversational Noise:** Omit narrative setup, preambles (`In this section we...`, `It is worth noting...`), and conversational meta-commentary.
* **No Binary Contrast:** State facts directly as absolute assertions. Never write binary contrast phrases (`it's not X, but Y`, `rather than Z`, `instead of A`).
* **No Dramatic Qualifiers:** Ban fluff adjectives (`crucial`, `actually matters`, `most important`, `key detail`).
* **Inline Comments:** Document *why* business constraints or mathematical thresholds exist. Do not write inline comments explaining *how* readable code executes line-by-line.

---

## 4. Execution Workflow
When executing tasks in this codebase:
1. Run existing tests before making logic changes.
2. Ensure any new network measurement or grading logic includes deterministic unit tests following the naming rule in Section 1.
3. Keep code blocks, markdown tables, and inline comments strictly technical and single-clause.