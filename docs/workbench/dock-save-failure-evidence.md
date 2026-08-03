# Save-failure notice — live evidence, gate closed

Commit `fa6983550` landed the fix round with one gate left open: finding #2's
save-failure notice was unit-proven but never observed rendering. This closes
it. All three observations were made in a real browser, one tab, against a
live backend.

## The trap that would have produced a false negative

The obvious test — fill `localStorage` until it throws, then drag a splitter —
**does not work**, and quietly reports success when nothing happened.

`setItem` on an **existing** key only needs headroom for the size _delta_, not
the whole value. The dock's layout key was already ~918 bytes, so overwriting
it with a same-sized value succeeded even with the rest of storage completely
full. 4MB of filler wrote fine and the notice never appeared — which a less
careful pass would have read as "the notice is broken", or worse, moved on
believing the check had run.

Forcing a genuine failure needed: `removeItem` the real key first (releasing
its own headroom), then exhaust the quota with shrinking chunks until even a
one-byte `setItem` throws. Only then does a drag produce a real
`QuotaExceededError` on the save path.

Recording this because it is a property of `localStorage`, not of this code,
and anyone re-running this check will hit it.

## (a) The notice renders — OBSERVED

With quota genuinely exhausted (verified by probing a write to the real key's
exact name _before_ touching the UI), a splitter drag produced a full-width
banner:

> "This workspace's layout couldn't be saved (Failed to execute 'setItem' on
> 'Storage': Setting the value of 't3-workbench-dock:layout:chat-dock-v2'
> exceeded the quota.). Your current arrangement is still visible, but won't
> survive a reload until storage is available again."

The wording carries the thing that actually matters — that the arrangement
will not survive a reload — in plain words rather than implying it. No rewrite
needed.

## (b) It fires once, not per debounce tick — OBSERVED

Dismissed the notice, confirmed it was gone from the DOM, dragged again.

The important part is how this was checked: the second save was confirmed to
have **genuinely also failed** (`localStorage.getItem(...) === null`), rather
than assuming no further saves occurred. Without that, "no second notice"
could just mean "no second save was attempted", which proves nothing.

The notice did not reappear.

Checking DOM _presence_ rather than whether the text changed is also what
makes this meaningful — a re-fire with identical copy is invisible to a
text-comparison check and obvious to an existence check.

## (c) The app degrades rather than breaks — OBSERVED

Both drags visibly resized the panel correctly while the background save
failed both times. No console errors or exceptions across the whole sequence.

This is the observation that proves the design: `save()` returning a result
instead of throwing is what makes a storage failure informational rather than
fatal.

## Cleanup

All 17 filler and probe keys removed, the real layout value restored from a
copy captured before the test, and a fresh reload confirmed the app renders
normally with `localStorage` back to its original 8 application keys. Nothing
left wedged.
