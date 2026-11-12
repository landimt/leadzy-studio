// navigator.clipboard is undefined outside secure contexts (UI opened via LAN
// IP instead of localhost) and writeText rejects without focus/permission —
// both must land on the same visible failure path, never a silent ✓-less click.
export function copyToClipboard(text: string, done: (ok: boolean) => void): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard === undefined) {
    done(legacyCopy(text));
    return;
  }
  clipboard.writeText(text).then(
    () => {
      done(true);
    },
    () => {
      done(legacyCopy(text));
    },
  );
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated but the only copy path in non-secure contexts (LAN IP), where navigator.clipboard does not exist
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
