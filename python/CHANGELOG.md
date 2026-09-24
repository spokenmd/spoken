# Changelog

## 0.2.0

Follows and what is new. `following()`, `follow(podcast_id)`, `unfollow(podcast_id)` and `new()`
wrap `/following` and `/new`: the shows a key is kept current on, and the episodes on them that have
not been fetched yet, each with a transcript URL. The command gains `following`, `follow`,
`unfollow` and `new`. Keeping a folder current is `spoken-md new` on a schedule and `transcript`
on each id it prints.

## 0.1.0

First release. `Spoken` client with `search`, `episodes`, `transcript`, `balance` and a resumable
`archive` generator; typed errors for 401, 402, 404, 429 and 502; a `spoken-md` command with the
same five verbs. No dependencies outside the standard library.
