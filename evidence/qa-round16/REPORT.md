# QA round 16 report — Browser panel loads typed URLs in-panel (guard fix)

Target: `DevGame (Alpha)`

## Item 0 — PREFLIGHT

**Verdict: PASS**

The first `get_app_state` call resolved the exact named app on the first attempt and exposed the benign `Raise` secondary action:

```text
Window: "DevGame (Alpha)", App: DevGame (Alpha).
0 standard window DevGame (Alpha), Secondary Actions: Raise
	1 container DevGame (Alpha)
		2 container
			3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

The `Raise` action completed successfully. Its follow-up sample ended with:

```text
The focused UI element is 3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

Neither preflight operation failed, so the two-failure blocking rule did not apply.

## Item 1 — FRESH-TAB HALF

**Verdict: PASS**

After focusing the Browser dock panel, clicking `New Tab`, typing exactly `example.com` in the panel URL bar, pressing Enter, and waiting approximately five seconds, the sample showed the new tab and normalized URL:

```text
												77 button The AI workspace that works for you. | Notion
												78 button Close The AI workspace that works for you. | Notion
												79 button Example Domain
												80 button Close Example Domain
												81 button Description: New browser tab, Help: New tab
												82 container
													83 container Navigation
														84 button Back
														85 button (disabled) Forward
														86 button Refresh
													87 text field (settable, string) Value: https://example.com/, Placeholder: Search or enter URL
```

The embedded page content was present in the same DevGame state:

```text
					148 HTML content Example Domain, URL: example.com/
						149 heading Example Domain, Value: 1
							150 text Example Domain
						151 text This domain is for use in documentation examples without needing permission. Avoid use in operations.
						152 link Description: Learn more, Value: iana.org/domains/example
```

No external-browser control was invoked, and the sample's focus line remained inside DevGame:

```text
The focused UI element is 3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

## Item 2 — LOADED-TAB HALF (F6 CASE)

**Verdict: PASS**

In the same loaded tab, the URL bar was selected, exactly `google.com` was typed, Enter was pressed, and the sample was taken after approximately five seconds. The panel showed the redirected `www` URL:

```text
												79 button Google
												80 button Close Google
												81 button Description: New browser tab, Help: New tab
												82 container
													83 container Navigation
														84 button Back
														85 button (disabled) Forward
														86 button Refresh
													87 text field (settable, string) Value: https://www.google.com/, Placeholder: Search or enter URL
```

Google content was present in-panel:

```text
					148 HTML content Google, URL: google.com/
						149 container
							150 container
								151 link Description: About, Value: about.google/?fg=1&utm_source=google-CA&utm_medium=referral&utm_campaign=hp-header
								152 link Description: Store, Value: store.google.com/CA?utm_source=hp_header&utm_medium=google_ooo&utm_campaign=GS100042&hl=en-CA
								153 link Description: Gmail , Value: mail.google.com/mail/&ogbl
								154 link Description: Search for Images , Value: google.com/imghp?hl=en&ogbl
								155 button Google apps
								156 link Description: Sign in, Value: accounts.google.com/ServiceLogin?hl=en&passive=true&continue=https://www.google.com/&ec=futura_exp_og_so_72776762_e
						157 image Google
```

The final sample again reported a focused DevGame element:

```text
The focused UI element is 3 HTML content DevGame (Alpha), URL: devgame://app/#/draft/385129c8-61c2-4775-8b32-40cc45d4083a
```

## Item 3 — REPORT AND FOCUS ACCOUNTING

**Verdict: PASS**

Focus did not leave the `DevGame (Alpha)` app at any point. No external Chrome window was opened or focused. PiP was not used; no Terminal-panel text, git control, or path under `~/Projects/Deepmind` was touched.

OVERALL VERDICT: PASS
