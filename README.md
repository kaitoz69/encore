# Encore

A personal music player for iPhone. Plain HTML, CSS and JavaScript, hosted on GitHub Pages and installed from Safari.

## First-time setup

### 1. Create the repository
1. Go to <https://github.com/new>.
2. Give it a name, for example `encore`.
3. Choose **Public**. GitHub Pages on a free account needs a public repository, so **anyone who finds the address or the repository can listen to and download your songs**.
4. Click **Create repository**.

### 2. Turn on GitHub Pages
1. In the repository, open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

There's no Save button: the choice applies immediately.

### 3. Upload the app
1. Go to the repository's main page and click **uploading an existing file**.
2. Open this `encore` folder on your computer, select everything inside it (including `.github`), and drag it onto the page.
3. Click **Commit changes**.

### 4. Check that it deployed
1. Open the **Actions** tab and wait for **Scan music and deploy** to show a green check.
2. Your app is at `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`. It will say "No music yet" until you add songs.

If the run failed because Pages wasn't turned on yet, finish step 2, then open the failed run and click **Re-run all jobs**.

## Adding music

1. Prepare a folder for each album, named after the album, with the songs and a `cover.jpg` inside. See [music/README.md](music/README.md).
2. In the repository, open the `music` folder.
3. Click **Add file → Upload files**, drag the album folder in, and click **Commit changes**.
4. A minute or two later, reopen the app. The new album will be there.

`songs.json` is generated on every upload, so there is nothing to edit. It isn't stored in the repository; it's published with the site.

GitHub's limits:

| Limit | Size |
| --- | --- |
| Per file, uploading in the browser | 25 MB |
| Per file, using [GitHub Desktop](https://desktop.github.com/) or git | 100 MB |
| Per upload, in the browser | 100 files |
| Whole site (recommended) | 1 GB |
| Traffic (recommended) | 100 GB a month |

A 128 to 192 kbps mp3 or m4a stays well inside these limits.

## Installing on iPhone

1. Open your app's address in **Safari**.
2. Tap the **Share** button. On newer iOS versions it may be under the **⋯** menu.
3. Scroll down and tap **Add to Home Screen**.
4. Leave **Open as Web App** on, if you see it, and tap **Add**.
5. Open it from the new home screen icon, not from Safari.

## Changing the name or logo

- **Name:** replace `Encore` in `index.html` (`<title>` and `apple-mobile-web-app-title`) and `manifest.json` (`name` and `short_name`).
- **Logo:** replace the PNG files in `icons/`, keeping the same names and sizes, and edit the `i-logo` symbol in `index.html`.

An installed icon doesn't update by itself: delete it from the home screen and add it again.

## Good to know

- Playing music needs a connection. Songs aren't saved for offline listening.
- The app also keeps Liked Songs, Recently Played and your last position on the phone, in the installed app's own storage. Deleting the home screen icon erases them.

## Running the scan yourself

Optional, and needs [Node.js](https://nodejs.org/):

```bash
node scripts/generate-songs.js
```
