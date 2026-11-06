# Encore

A personal music player for iPhone, installed to the home screen from Safari. It's built with plain HTML, CSS and JavaScript and hosted on GitHub Pages.

**Open it:** <https://kaitoz69.github.io/encore/>

## What it does

- Browse albums on Home, search your songs, and find Liked Songs, Recently Played and All Songs in Library.
- Play from a mini player or the full-screen Now Playing view, with shuffle and repeat.
- Control playback from the lock screen and Control Center, with cover art.
- Keep playing while the phone is locked.
- Pick up from the last song and position when you reopen it.

Songs stream over the internet, so it needs a connection to play.

## Adding music

1. Make a folder named after the album, with the songs and a `cover.jpg` inside:

   ```
   Gym/
     cover.jpg
     01 - Outside.mp3
     02 - Do I Wanna Know.mp3
   ```

2. On GitHub, open the [`music`](music) folder and click **Add file → Upload files**.
3. Drag the folder in and click **Commit changes**.

That's all. The song list rebuilds by itself, and the album appears in the app a couple of minutes later. To add songs to an existing album, open its folder in `music` and upload them there.

See [`music/README.md`](music/README.md) for formats and how titles and order work.
