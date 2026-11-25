# Kiln

A sound transformation workshop for Mac and Windows, in the spirit of the [Composers Desktop Project](https://www.composersdesktop.com/) (CDP): you take a sound, put it through a process, and every result becomes a new sound you can process again. It is the fourth tool alongside Reel Studio, Orbit and Spiders, and it shares their effects.

Kiln is written from scratch (Electron + JavaScript, no native code). It does not include or run CDP's own programs; the processes are new implementations of the same ideas.

## What it does

- **Sounds bin**: import WAV, AIFF, MP3, FLAC, OGG or M4A (WAV and AIFF keep their own sample rate). Rendered sounds sit under the sound they came from, so the bin reads as a family tree.
- **History**: every sound remembers the chain of steps that made it. Click **Edit** on any step to load those settings with the same source and try again.
- **Curves (breakpoints)**: press **~ curve** under almost any knob to draw how that setting changes over the length of the sound, like a CDP breakpoint file.
- **Two-input processes**: morph, cross-synthesis, waveset interleave, envelope transfer, join and mix take a second sound **B**.
- **Selection only**: drag across the waveform to process just that part, or make it a new sound.
- **A/B**: play the source of the current sound at the same point (⌘B).
- **Recipes**: save a sound's history as a recipe and apply it to any number of sounds in one go. Curves are stored as a share of the length, so they fit sounds of any length.
- **Views**: waveform, spectrogram, or both.
- **Export**: WAV (16, 24 or 32-bit float) or MP3, one sound or every sound into a folder. Projects save as `.kiln` files with the audio inside.

## Processes (57 including the effects chain)

**Spectral (phase vocoder)**: Blur, Smear, Freeze & hold, Time stretch (spectral), Transpose (spectral), Formant shift, Trace partials, Spectral clean / residue, Morph (A+B), Cross-synthesis (A+B), Shift & stretch partials, Tune to scale, Spectral sweep, Spectral scatter, Spectral shuffle, Spectral reverse

**Waveset distortion**: Waveset repeat, Waveset omit, Waveset reverse, Waveset shuffle, Waveset interleave (A+B), Waveset average, Waveset multiply, Waveset divide, Waveset replace, Waveset envelope, Waveset filter, Waveset pitch warp, Waveset harmonics

**Granular & texture**: Brassage (granulator), Texture cloud, Grain reverse, Grain repeat, Shred, Scramble, Iterate, Stutter (vocal chop)

**Time & pitch**: Varispeed, Time stretch (wave), Pitch shift (wave), Reverse, Loop & step, Zigzag, Drunken walk, Tremolo & pulse, Draw envelope, Envelope transfer (A+B), Pan & spin

**Edit & mix**: Normalise, Gain, Fade in / out, Trim silence, Join (A then B) (A+B), Mix (A with B) (A+B), Channels & width

**Effects**: the shared chain from Reel Studio, Orbit and Spiders: EQ, filter, compressor, saturation, distortion, phaser / flanger / chorus, echo, reverb, trance gate and vocoder.

## Keys

| | |
|---|---|
| Space | play / stop (plays the selection if there is one) |
| ⌘↵ | render |
| ⌘J | use the result as input A |
| ⌘B | A/B: play the source |
| ⌘D | selection to a new sound |
| ⌘F | find a process |
| ⌘L | loop |
| ↑ ↓ | move through the sounds |
| Esc | cancel a render, or clear the selection |

## Building

GitHub Actions builds the apps on every push (no Xcode needed): open the latest run under **Actions** and download **Kiln-mac** (a DMG for Apple Silicon and one for Intel) or **Kiln-win**. Pushing a tag such as `v1.0.0` also creates a release.

The Mac app is not notarised, so the first time you open it macOS will block it: go to **System Settings → Privacy & Security** and choose **Open Anyway**.

```
npm install
npm start        # run it
npm test         # check every process on synthetic sounds
```

## Code

- `src/dsp/`: the processes. `core.js` holds the FFT, phase vocoder, waveset finder, onset detection and the breakpoint parameter system; `spectral.js`, `waveset.js`, `granular.js` and `time.js` hold the processes. The same files run in the window (for their settings) and in a background worker (to render).
- `src/js/app.js`: the interface. `waveview.js` draws the sound and the curve lanes, `audio.js` reads and writes files and plays sound, `jobs.js` runs the worker.
- `src/js/effects.js`, `knob.js` and `fxui.js` come from Spiders.
