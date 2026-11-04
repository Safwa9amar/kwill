import { beforeEach, describe, expect, it } from "vitest";
import { useNoteDraft } from "./rescue-note-draft";

const D = () => useNoteDraft.getState();

beforeEach(() => {
  useNoteDraft.setState({ projectId: null, text: null, lang: null });
});

describe("the note draft", () => {
  it("keeps the text and the language for the project it was typed in", () => {
    D().setText("A", "Times 12");
    D().setLang("A", "fr-FR");
    expect(D().projectId).toBe("A");
    expect(D().text).toBe("Times 12");
    expect(D().lang).toBe("fr-FR");
  });

  it("drops project A's text when a language is picked for project B", () => {
    D().setText("A", "Note of project A");
    D().setLang("B", "ar-SA");
    expect(D().projectId).toBe("B");
    expect(D().text).toBeNull();
    expect(D().lang).toBe("ar-SA");
  });

  it("drops project A's language when text is typed for project B", () => {
    D().setLang("A", "en-US");
    D().setText("B", "Note of B");
    expect(D().projectId).toBe("B");
    expect(D().text).toBe("Note of B");
    expect(D().lang).toBeNull();
  });

  it("keeps the text when the language is changed in the same project", () => {
    D().setText("A", "still mine");
    D().setLang("A", "en-US");
    expect(D().text).toBe("still mine");
  });
});
