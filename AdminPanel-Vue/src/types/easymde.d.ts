declare module 'easymde' {
  interface EasyMDEOptions {
    element?: HTMLTextAreaElement;
    spellChecker?: boolean;
    status?: string[];
    minHeight?: string;
    maxHeight?: string;
    placeholder?: string;
    toolbar?: string[];
    renderingConfig?: {
      singleLineBreaks?: boolean;
      codeSyntaxHighlighting?: boolean;
    };
    [key: string]: unknown;
  }

  class EasyMDE {
    constructor(options: EasyMDEOptions);
    value(content?: string): string;
    toTextArea(): void;
    isPreviewActive(): boolean;
    togglePreview(): void;
    clearAutosavedValue(): void;
    cleanup(): void;
    codemirror: unknown;
  }

  export default EasyMDE;
}
