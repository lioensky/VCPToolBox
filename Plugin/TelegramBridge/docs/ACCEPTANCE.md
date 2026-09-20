# Installation acceptance checklist

Automated tests use synthetic identifiers, isolated databases and mocked network boundaries. They do not establish that a particular Bot, model or deployment passed live acceptance.

- [ ] probe succeeds on the target runtime with the integrated host.
- [ ] A configured owner gets one reply; an unauthorized user cannot invoke the Agent or tools.
- [ ] /agent, /new, /status and /stop work in the intended scope.
- [ ] Text retains context across several turns and an idle interval.
- [ ] A captioned image and a captionless image followed by a question produce the intended single turn.
- [ ] A new image album, audio, video and text file are understood by the configured backend model.
- [ ] Local and public HTTPS attachments arrive once, with private/unsafe paths rejected.
- [ ] An approval button resolves only its associated request; administrator authentication remains enforced by the host.
- [ ] A generic asynchronous tool completion delivers once; restart does not replay tool effects.
- [ ] Restart recovery and cancellation preserve uncertain records for review.

Keep private evidence locally. Publish only aggregate results, runtime versions and sanitized error codes. Do not include real identities, messages, credentials, attachment paths or raw state.
