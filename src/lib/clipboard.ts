/**
 * Copy text to the clipboard: the Clipboard API where it works, otherwise the old select-and-copy
 * trick (the Clipboard API needs a secure page, and nearby play also runs on http LAN addresses).
 */

function copyWithTextarea(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    copyWithTextarea(text);
  }
}
