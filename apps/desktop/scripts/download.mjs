/**
 * One download for the fetch-* scripts, asked again when the server says it
 * could not answer right now.
 *
 * GitHub's release downloads answer 502, 503 or 504 now and then, and one
 * such answer failed a whole CI job before any test ran. A 5xx or a network
 * error is asked again, five times more, twice as late each time: about a
 * minute in all, as one spell of 504s outlasted 14 s. Any other answer is
 * final. What comes back is checked against its pin by the caller, so
 * asking again can never hand on different bytes.
 */

const ATTEMPTS = 6;

/** The body of `url`, or the process ends with why, under `label`. */
export async function download(
  label,
  url,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
) {
  for (let attempt = 1; ; attempt += 1) {
    let said;
    try {
      const response = await fetch(url);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      said = `answered ${response.status} ${response.statusText}`;
      if (response.status < 500) return fail(label, url, said);
    } catch (error) {
      said = `could not be reached (${error.cause?.code ?? error.message})`;
    }
    if (attempt === ATTEMPTS)
      return fail(label, url, `${said}, ${ATTEMPTS} times`);
    console.error(`${label}: ${url} ${said}; asking again`);
    await wait(2_000 * 2 ** (attempt - 1));
  }
}

function fail(label, url, said) {
  console.error(`${label}: ${url} ${said}`);
  process.exit(1);
}
