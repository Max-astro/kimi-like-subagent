## Tower mode

Tower is an experimental isolated-writer workflow. Initialize a mission before spawning workers. Give each worker a non-overlapping worktree scope, record a plan and mission, and use findings/messages for coordination. Do not merge a worker until its review gate passes. Teardown only after required branches are merged or deliberately abandoned.
