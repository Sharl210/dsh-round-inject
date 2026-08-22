# DSH Composer IME Patch (upstream)

**Bug**: clicking the Send button in the chat composer while a Chinese/Japanese
IME composition is in flight submits the uncommitted pinyin/kana as a message.
The Enter path guards with `composingRef.current || e.nativeEvent.isComposing ||
e.nativeEvent.keyCode === 229`; the button (`onPrimary`) path had no guard.

**Patch file**: `node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`
(inside the global `@deepseek-ai/dsh` install). Applied 2026-08-23.

```diff
 			const onPrimary = () => {
 				if (primaryStops) {
 					stop?.();
 					return;
 				}
 				if (inputActions === void 0) return;
+				// IME guard: clicking Send while a Chinese/Japanese composition is
+				// in flight must not submit the uncommitted pinyin/kana. The Enter
+				// path already checks composing; the button path was missing it.
+				if (composingRef.current) return;
 				/* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
 				if (!empty && !disabled && !machineBusy) inputActions.submit();
 			};
```

**Verification** (isolated instance, real browser):
- composition in flight + click Send → draft retained, no message sent ✓
- composition ends + click Send → message sent normally ✓

**Caveat**: this edits the npm-installed `node_modules` file; a DSH upgrade
overwrites it. Re-apply after upgrading, or submit upstream
(https://github.com/deepseek-ai/deepseek-harness).
