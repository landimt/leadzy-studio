# Privacy

Leadzy Studio is designed around local project files. This document describes
the data flows in the current beta; it is not a substitute for the privacy
policies of optional third-party services.

## What stays local

- Source footage and project folders remain on the user's machine.
- Edits, transcripts, waveforms, previews, renders, QA reports, and history are
  stored under the creative's local `edit/` directory.
- The project search index is a local, rebuildable SQLite database.
- Leadzy Studio does not include product analytics, advertising trackers, or a
  crash-reporting service.

## Optional network activity

### ElevenLabs Scribe

When the user explicitly starts visual transcription or QA with Scribe, the
Studio extracts audio from the selected local media or final render and sends
that audio — together with the document's `transcription.keyterms` (brand,
product and people names the user wrote into `edit.json`) — to the ElevenLabs
speech-to-text API. ElevenLabs' terms and privacy policy apply to that
processing. No other transcription engine is used.

An ElevenLabs key entered in Settings is stored unencrypted in
`~/.leadzy-studio/config.json` with owner-only file permissions where supported.
It may instead be supplied through the process environment or the repository's
ignored `.env` file. The key is not written into creative folders or returned
to the browser UI in full.

### Application updates

Packaged builds check the public GitHub release feed periodically for updates.
That request is made to GitHub, not to a Leadzy analytics endpoint. Normal
network metadata such as an IP address and user agent may be processed by
GitHub under its own policies.

### Optional templates and agents

The current title-card template fetches its pinned GSAP script from jsDelivr
when rendered. It does not upload footage, but the request exposes ordinary
network metadata to the CDN. This dependency is documented in
[third-party notices](THIRD_PARTY_NOTICES.md) and is planned for removal or
reviewed vendoring.

Claude Code, Codex, or another optional agent is not required to use the
editor. If the user chooses an agent integration, data handled by that agent is
subject to the selected agent and model provider's configuration and policies.

## Deleting local data

Leadzy Studio does not control backup copies. Users can remove a creative's
generated state by deleting its `edit/` directory after keeping any wanted
exports, and can remove the local search/config data under the platform's
Leadzy Studio data directories. Original media is outside the editor's cleanup
contract and is never automatically deleted.
