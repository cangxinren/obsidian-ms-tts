import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { Editor } from 'obsidian';

type Range = { from: number; to: number } | null;

export const setHighlightEffect = StateEffect.define<Range>();

export const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlightEffect)) continue;
      const value = effect.value;
      if (!value || value.to <= value.from) {
        next = Decoration.none;
      } else {
        next = Decoration.set([
          Decoration.mark({ class: 'ms-tts-active' }).range(value.from, value.to),
        ]);
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

interface EditorWithCm extends Editor {
  cm?: EditorView;
}

export function highlightEditor(editor: Editor, from: number, to: number, scroll: boolean): boolean {
  const view = (editor as EditorWithCm).cm;
  if (!view) {
    if (scroll) {
      try {
        editor.scrollIntoView(
          { from: editor.offsetToPos(from), to: editor.offsetToPos(to) },
          true,
        );
      } catch {
        // ignore
      }
    }
    return false;
  }

  try {
    const length = view.state.doc.length;
    const start = Math.max(0, Math.min(from, length));
    const end = Math.max(start, Math.min(to, length));

    view.dispatch({
      effects: setHighlightEffect.of(end > start ? { from: start, to: end } : null),
    });

    if (scroll) {
      editor.scrollIntoView(
        { from: editor.offsetToPos(start), to: editor.offsetToPos(end) },
        true,
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function clearEditorHighlight(editor: Editor): void {
  const view = (editor as EditorWithCm).cm;
  if (!view) return;
  try {
    view.dispatch({ effects: setHighlightEffect.of(null) });
  } catch {
    // ignore
  }
}
