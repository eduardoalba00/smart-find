# Smart Find

Ctrl+F for questions. Ask any web page a question and Smart Find highlights the passages that answer it, then jumps you straight to them.

<!-- demo GIF goes here -->

Built on [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), TypeSafe's fast decision model.

## How it works

1. Smart Find splits the page into short passages, keeping each one's section heading as context.
2. Jev scores every passage against your question in parallel, 8 passages per request, starting with what's on screen.
3. Matches are highlighted on the page and marked on the scrollbar. Passages that don't answer the question stay unmarked, so if nothing fits, it says so.

Unlike Ctrl+F, it matches meaning, not words: "can I make this without eggs?" finds the reader comment about substituting eggs.

## Speed and cost

Measured on real pages (Wikipedia, a long Hacker News thread, a recipe site):

- **0.4 to 0.9 seconds** per search
- **$0.0005 to $0.007** per search, depending on page length

In testing, the top result answered the question for 15 of 15 questions on clean pages and 19 of 20 on messy ones (comment threads, recipe blogs, terms of service).

## Install

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension` folder.
4. Paste your TypeSafe API key into the page that opens. Get a key from [TypeSafe](https://docs.typesafe.ai/introduction/quickstart); new accounts may need to join a waitlist.

## Use

- **Ctrl+Shift+Space** (or the toolbar button) opens Smart Find on the current page.
- Type a question and press **Enter**.
- **↑ ↓** pick a result, **Enter** jumps to it. After a jump, **↑ ↓** step through the matches.
- **Esc** closes it.

Change the shortcut at `chrome://extensions/shortcuts`.

## Privacy

Your API key is stored only in your browser. Page text is sent to TypeSafe's Jev API only when you run a search, never in the background. There is no server of mine in between.

## License

[MIT](LICENSE)
