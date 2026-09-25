**Haiso — Discord guide**

**Channels**
One category per project folder; sessions in it can message each other. 🟣 = Haiso session · 🔵 = OMP session (omp-bridge). `#overview` lists both. This channel holds the guide, not a session.

**In a session channel**
Send text to chat; it waits until the agent is idle. Controls are owner-only.
{{commands}}
• `!steer <text>` — guide active work · `!abort` — cancel the current turn (no rollback)
**Settings** on the card opens the same panel; changes apply after the current turn. Mentions default to approvals/questions and replies that took ≥2 min. Long replies arrive as a preview + `haiso-reply.md`.

**Sharing — terminal**
Haiso: `/discord on` once per conversation. OMP: `/bridge on`. Sharing is remembered: resuming the conversation rejoins its channel. `/discord off` / `/bridge off` makes it private (sticky).
The service stays online after your last terminal closes and updates itself once every session is idle. A closed session shows *Closed* with a **Resume** button; messages sent to it are saved and offered when it resumes. `/session resume`/`new` run conversations in the background; opening one at your desk takes it over.

**Delete — terminal**
`/session delete`, `/delete`, or the picker: keep Discord history (channel archived) · delete both · cancel.

Terminal only: permanent delete, approval rules, logins.
