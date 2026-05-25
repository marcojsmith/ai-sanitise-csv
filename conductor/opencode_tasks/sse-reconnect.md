# Task: Graceful SSE reconnection on frontend (item 6)

## Context

File: `public/index.html`

The `startReviewSSE` function is at line ~810. The current `onerror` handler (line 832) silently closes the SSE connection:

```js
reviewSSE.onerror = () => { reviewSSE.close(); reviewSSE = null; };
```

There is also a `reviewSSE` variable declared at file scope (global JS), and a `reviewJobId` variable used when calling `startReviewSSE(reviewJobId)`.

The review phase UI shows phase dots: `dot-mapping`, `dot-applying`, `dot-writing`, and a `review-error-msg` element.

## Instructions

1. Read `public/index.html` fully first to understand the structure.

2. Replace the `onerror` handler in `startReviewSSE` (line 832) with one that:
   - Shows a "Connection lost, reconnecting..." message in the `review-error-msg` element (but with a yellow/warning style — add `style="color: var(--yellow)"` inline, or just use the existing element)
   - Attempts to reconnect after 3 seconds by calling `startReviewSSE(jobId)` again
   - Only reconnects if the job is not in a terminal state (i.e., we haven't received `done` or `error` events — track with a local boolean flag `reviewComplete` scoped inside `startReviewSSE`)

Here is the replacement code for the `onerror` handler and the function structure:

```js
function startReviewSSE(jobId) {
  if (reviewSSE) reviewSSE.close();
  let reviewComplete = false;
  reviewSSE = new EventSource('/api/progress/' + jobId);
  reviewSSE.onmessage = e => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'phase' && ['mapping','applying','writing'].includes(ev.phase)) {
        document.getElementById('dot-' + ev.phase).className = 'phase-dot active';
      }
      if (ev.type === 'done') {
        reviewComplete = true;
        ['mapping','applying','writing'].forEach(p => document.getElementById('dot-' + p).className = 'phase-dot done');
        document.getElementById('review-done-msg').style.display = 'block';
        reviewSSE.close(); reviewSSE = null;
      }
      if (ev.type === 'error') {
        reviewComplete = true;
        const el = document.getElementById('review-error-msg');
        el.textContent = 'Error: ' + ev.message;
        el.style.display = 'block';
        reviewSSE.close(); reviewSSE = null;
      }
    } catch {}
  };
  reviewSSE.onerror = () => {
    if (reviewComplete) { reviewSSE.close(); reviewSSE = null; return; }
    const el = document.getElementById('review-error-msg');
    el.textContent = 'Connection lost, reconnecting...';
    el.style.display = 'block';
    reviewSSE.close(); reviewSSE = null;
    setTimeout(() => startReviewSSE(jobId), 3000);
  };
}
```

3. Replace the entire existing `startReviewSSE` function with the above.

## Constraints
- Plain JS, no new dependencies
- Do not alter anything outside the `startReviewSSE` function

## Results

Done. Replaced `startReviewSSE` in `public/index.html` (lines 810-837) with graceful reconnection logic: shows "Connection lost, reconnecting..." warning in `review-error-msg`, retries after 3s via `setTimeout`, and only reconnects if not in a terminal state (tracked by `reviewComplete` flag).
