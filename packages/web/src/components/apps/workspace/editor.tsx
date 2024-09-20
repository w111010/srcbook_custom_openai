import CodeMirror from '@uiw/react-codemirror';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { cn } from '@/lib/utils';
import useTheme from '@/components/use-theme';
import { useFiles } from '../use-files';
import { FileType } from '@srcbook/shared';

type PropsType = {
  className?: string;
};

export function Editor(props: PropsType) {
  const { openedFile } = useFiles();

  return (
    <div className={cn(props.className)}>
      <div className="p-3 w-full h-full">
        {openedFile ? (
          <CodeEditor file={openedFile} />
        ) : (
          <div className="h-full flex items-center justify-center text-tertiary-foreground">
            Use the file explorer to open a file for editing
          </div>
        )}
      </div>
    </div>
  );
}

function extname(path: string) {
  return '.' + path.split('.').pop();
}

function CodeEditor({ file }: { file: FileType }) {
  const { codeTheme } = useTheme();

  const languageExtension = getCodeMirrorLanguageExtension(file);
  const extensions = languageExtension ? [languageExtension] : [];

  return (
    <CodeMirror
      value={file.source}
      theme={codeTheme}
      extensions={extensions}
      onChange={(source) => {
        console.log(source);
      }}
    />
  );
}

function getCodeMirrorLanguageExtension(file: FileType) {
  switch (extname(file.path)) {
    case '.json':
      return json();
    case '.css':
      return css();
    case '.html':
      return html();
    case '.md':
    case '.markdown':
      return markdown();
    case '.js':
    case '.cjs':
    case '.mjs':
    case '.jsx':
    case '.ts':
    case '.cts':
    case '.mts':
    case '.tsx':
      return javascript({ typescript: true, jsx: true });
  }
}
