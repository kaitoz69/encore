# Your music goes here

Make one folder per album or playlist. The folder name becomes its title.

```
music/
  Gym/
    cover.jpg
    Katy Perry - Firework.mp3
    Katy Perry - Firework.jpg
    Eminem - Lose Yourself.mp3
  Fairouz/
    artist.txt
    cover.jpg
    01 - First Song.mp3
    02 - Second Song.mp3
```

## Artist names

Use whichever suits the folder:

- **Different artists:** name the file `Artist - Song.mp3`, like `Katy Perry - Firework.mp3`.
- **One artist for the whole folder:** add a text file called `artist.txt` with the name on its first line.

`artist.txt` overrides everything else. If a file has an artist in its own tags, the tags are used before the file name.

## Covers

- **Album cover:** add `cover.jpg`. Any other image in the folder also works if there's no `cover.jpg`.
- **Song cover:** give the image the same name as the song, like `Katy Perry - Firework.jpg` next to `Katy Perry - Firework.mp3`. It shows on the song's row, in the player and on the lock screen. Songs without their own cover use the album's.
- **Image types:** jpg, png or webp. iPhone `.heic` photos need converting first. Square images around 1000 x 1000 px look best.

## Song titles and order

- **Titles:** taken from the file's tags if it has them, otherwise from the file name. Extras like `(Official Video)`, `(Lyrics)` and a trailing `- 320` are removed.
- **Order:** a leading number like `01 - ` sets the order and is left out of the title.
- **Formats:** mp3, m4a, aac, wav, flac. Use mp3 or m4a to keep file sizes small.

Renaming a song or moving it to another folder clears it from Liked Songs and Recently Played, so you'd need to like it again.
