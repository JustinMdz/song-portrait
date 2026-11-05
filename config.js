/* ════════════════════════════════════════════════════════════════════
   THIS IS THE ONLY FILE YOU NEED TO EDIT.

   To make your own portrait:
     1. Put your photo and your lyrics (.txt) in the content/ folder
     2. Change the details below
     3. Publish it on GitHub Pages (the steps are in the README)

   Careful: capitalization matters on GitHub. "Photo.jpg" and "photo.jpg"
   are different files, so type the names exactly as they are.

   The sample content is made up: the image is painted with code, and
   neither the songs nor the artists exist.
   ════════════════════════════════════════════════════════════════════ */

window.PORTRAIT = {

  /* The person's name. It appears large on the cover. */
  name: "Alma",

  /* The photo. Works best when it's vertical and the face is well lit. */
  photo: "content/portrait.jpg",

  /* Optional: a black and white image where white = person and
     black = background. If you remove it (or leave ""), the page finds
     the person on its own, so DELETE THIS LINE when you change the photo. */
  mask: "content/portrait-mask.png",

  /* The songs. Add as many as you like, they don't have to be three.

       title    → song title
       artist   → who sings it
       lyrics   → .txt file with the lyrics as they are, one verse per line
       listen   → optional: link to the song. Left empty (""), the button
                  searches for the song on Spotify. With false, no button
       palette  → optional: three colors [shadows, midtones, highlights].
                  Each song can have its own mood */
  songs: [
    {
      title: "Orange Afternoon",
      artist: "The Imaginary Orchestra",
      lyrics: "content/song1.txt",
      listen: false,
      palette: ["#2a1407", "#d4923f", "#fff0d6"],   // amber
    },
    {
      title: "Mile Zero",
      artist: "Nobody Yet",
      lyrics: "content/song2.txt",
      listen: false,
      palette: ["#2a0610", "#e23a58", "#ffe0d6"],   // crimson
    },
    {
      title: "Violet Sunday",
      artist: "The Made-Up Band",
      lyrics: "content/song3.txt",
      listen: false,
      palette: ["#120a38", "#8b6cff", "#ffd6f0"],   // violet
    },
  ],

  /* Every piece of text on the page. */
  text: {
    eyebrow: "A portrait made of songs",
    lede: "Every stroke of this image is a word from the songs you love most.",
    scroll: "Scroll",
    hintMouse: "Move your cursor over the portrait to read it",
    hintTouch: "Tap the portrait to read it",
    songLabel: "Song",
    listen: "Listen",
    loading: "Writing",

    endingEyebrow: "For you",
    endingTitle: "Every word ends with you.",
    endingMessage: "Write your dedication here: why these songs, why this person, why today.",
    signature: "Your name",
    restart: "Start over",
  },

  /* Fine tuning. You usually don't need to touch these. */
  options: {
    uppercase: true,   // portrait letters in uppercase (more even texture)
    density: 1,        // 1 = normal · 1.2 = smaller letters and more detail
    flow: 1,           // how fast the text flows · 0 = still
  },
};
