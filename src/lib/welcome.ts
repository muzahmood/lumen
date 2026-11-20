/** First-run note that shows what the editor can do. Created only when the knowledgebase is empty. */
export const WELCOME_TITLE = 'Welcome to Lumen';

export const WELCOME_NOTE = `Lumen is where your notes, diagrams and drawings live, side by side and linked together. Everything is plain Markdown, so your notes stay readable anywhere. Switch between **Edit** and **Read** at the top right, or press Ctrl/⌘ + E.

> [!tip] The quickest way in
> While editing, type **/** at the start of a line for headings, task lists, tables, diagrams, drawings, images and more. Type **[[** to link to another note.

## Tasks

- [x] Open this note
- [ ] Tick a box right here in reading view
- [ ] Create a folder from the sidebar and drag a note into it

## Diagrams

Write a diagram as text and it's drawn for you. Choose **Edit diagram** on it to open the live editor with templates. In reading view, click a diagram to see it full screen.

\`\`\`mermaid
flowchart LR
    A[Capture] --> B{Worth keeping?}
    B -- Yes --> C[Tag and file it]
    B -- Not yet --> D[Journal]
    C --> E[(Lumen)]
    D --> E
\`\`\`

## Drawings and images

- Use **/drawing** (or the pen button) for a freehand sketch or whiteboard; it's saved with the note and stays editable.
- Paste or drop an image straight into the editor. Large photos are shrunk before upload.
- Set a width with \`![caption|300](…)\`.

## Formatting

==Highlight== key phrases, use **bold**, *italic*, ~~strikethrough~~ and \`inline code\`.

| Shortcut | Does |
| --- | --- |
| Ctrl/⌘ + K | Search notes and run commands |
| Alt + N | New note |
| Ctrl/⌘ + S | Save now (it also saves as you type) |

Math works inline, like $e^{i\\pi} + 1 = 0$, or as a block:

$$
\\int_0^1 x^2\\,dx = \\tfrac{1}{3}
$$

\`\`\`ts
// Code blocks are highlighted in over 30 languages.
const greet = (name: string) => \`Hello, \${name}\`;
\`\`\`

> [!warning] Keep a backup
> Settings → Data → **Download backup** saves every note, image and drawing as a .zip of Markdown files.

<details>
<summary>More callout types</summary>

> [!note] Note
> Neutral information.

> [!danger] Danger
> Something that can't be undone.

> [!question] Question
> An open question to come back to.

</details>
`;
