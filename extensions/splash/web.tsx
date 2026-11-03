import { TriangleAlertIcon, XIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, defineWebExtension, errorMessage, resumed, useReady } from '@/sdk'
import { store } from '@/sdk/client'
import { StatusAction } from '../onboarding/ui.tsx'

/** The core's readiness deadline: not ready by then, the app opens anyway and the notice names what is missing. */
const timeout = 8000

/**
 * ULTIMATE as the header sets it, Inter SemiBold tracked 0.28em, at display size: the outlines of Inter's `opsz` 32,
 * `wght` 600 instance with overlaps removed, kerned by HarfBuzz. Font units (2048 per em), y down: the caps span 0 to
 * 1490 and U overshoots to 1514. One path per contour, so each traces on its own; A is its outline, then its counter.
 */
const letters: readonly (readonly string[])[] = [
  [
    'M721 1514Q539 1514 403.5 1445Q268 1376 193 1254.5Q118 1133 118 975L118 0L379 0L379 954Q379 1049 421 1122.5Q463 1196 539.5 1238Q616 1280 721 1280Q826 1280 902.5 1238Q979 1196 1020.5 1122.5Q1062 1049 1062 954L1062 0L1323 0L1323 975Q1323 1134 1248.5 1255.5Q1174 1377 1038.5 1445.5Q903 1514 721 1514Z',
  ], // U
  ['M2138 1490L2138 0L2402 0L2402 1261L3093 1261L3093 1490Z'], // L
  ['M3567 229L3567 0L4758 0L4758 229L4296 229L4296 1490L4031 1490L4031 229Z'], // T
  ['M5766 0L5766 1490L5502 1490L5502 0Z'], // I
  [
    'M6587 1490L6587 0L6967 0L7257 783Q7272 826 7291.5 887Q7311 948 7332 1015Q7351 1076 7368 1131Q7385 1076 7404 1015Q7425 948 7444.5 887Q7464 826 7478 783L7763 0L8145 0L8145 1490L7885 1490L7885 730Q7885 681 7886 616.5Q7887 552 7889.5 480.5Q7892 409 7894 335Q7894 321 7894 306Q7888 327 7881 348Q7857 426 7834 497.5Q7811 569 7791.5 628.5Q7772 688 7758 730L7474 1490L7258 1490L6972 730Q6958 688 6937.5 628.5Q6917 569 6894 497.5Q6871 426 6846 348Q6843 338 6839 328Q6839 332 6840 335Q6841 409 6843 480.5Q6845 552 6846 616.5Q6847 681 6847 730L6847 1490Z',
  ], // M
  [
    'M8855 1490L9387 0L9719 0L10249 1490L9958 1490L9839 1134L9261 1134L9139 1490Z',
    'M9767 917L9697 707Q9658 583 9615 443Q9587 352 9553 239Q9520 352 9492 443Q9448 583 9407 707L9335 917Z',
  ], // A
  ['M10681 229L10681 0L11872 0L11872 229L11410 229L11410 1490L11145 1490L11145 229Z'], // T
  [
    'M12616 1490L12616 0L13651 0L13651 229L12880 229L12880 621L13593 621L13593 846L12880 846L12880 1261L13651 1261L13651 1490Z',
  ], // E
]
const view = { x: 118, width: 13533, height: 1514 }
const outline = letters.flat().join('')

/** Each letter's horizontal extent in font units, from its outline's x coordinates (every path point is absolute). */
const extents = letters.map((paths) => {
  const xs = paths
    .join(' ')
    .match(/-?\d+(?:\.\d+)?/g)!
    .map(Number)
    .filter((_, index) => index % 2 === 0)
  const x = Math.min(...xs)
  return { x, width: Math.max(...xs) - x }
})
/** A length in font units as a share of the wordmark's width. */
const share = (units: number) => `${(units / view.width) * 100}%`

/** Where the light starts and ends, as a share of the wordmark's width: just past either end. */
const travel = { from: -0.12, to: 1.12 }
/** The light's width, as a share of the wordmark's. */
const beam = 0.12

/**
 * The wordmark: a soft glow behind it, the light that crosses it, and its letters, each with a lit copy above it that
 * flares as the light passes. Every part is its own box, so the browser animates their transform and opacity without
 * the main thread. `still` (reduced motion) shows the letters as they settle.
 */
function Wordmark({ still }: { still: boolean }) {
  const hidden = still ? '' : 'opacity-0'
  return (
    <div className="relative">
      <svg
        aria-hidden="true"
        className="block w-full"
        viewBox={`${view.x} 0 ${view.width} ${view.height}`}
      />
      <svg
        aria-hidden="true"
        className={`absolute inset-0 size-full overflow-visible ${still ? 'opacity-40' : 'opacity-0'}`}
        data-glow=""
        viewBox={`${view.x} 0 ${view.width} ${view.height}`}
      >
        <filter height="260%" id="splash-glow" width="130%" x="-15%" y="-80%">
          <feGaussianBlur stdDeviation="180" />
        </filter>
        <path className="fill-brand/50 dark:fill-brand" d={outline} filter="url(#splash-glow)" />
      </svg>
      {!still && (
        <div
          className="absolute top-1/2 left-0 h-[420%] -translate-y-1/2 bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--brand)_30%,transparent),transparent)] opacity-0 dark:bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--brand)_30%,white),color-mix(in_oklab,var(--brand)_40%,transparent)_35%,transparent)]"
          data-light=""
          style={{ width: `${beam * 100}%` }}
        />
      )}
      {letters.map((paths, index) => {
        const { x, width } = extents[index]
        const box = `${x} 0 ${width} ${view.height}`
        return (
          <div
            className={`absolute inset-y-0 ${hidden}`}
            data-letter=""
            key={x}
            style={{ left: share(x - view.x), width: share(width) }}
          >
            <svg
              aria-hidden="true"
              className="absolute inset-0 size-full overflow-visible"
              viewBox={box}
            >
              <path className="fill-brand" d={paths.join('')} />
            </svg>
            {!still && (
              <svg
                aria-hidden="true"
                className="absolute inset-0 size-full overflow-visible opacity-0"
                data-lit=""
                viewBox={box}
              >
                <path
                  className="fill-[color-mix(in_oklab,var(--brand)_55%,white)] dark:fill-[color-mix(in_oklab,var(--brand)_25%,white)]"
                  d={paths.join('')}
                />
              </svg>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** On screen at least this long, so a warm start does not flash. */
const minimum = { motion: 700, still: 400 }
/** The light crosses the name in this long. */
const sweep = 560
/** A letter rises into place in this long, starting just before the light reaches it. */
const rise = 380
const lead = 60
/** A lit letter cools to the brand colour in this long. */
const cool = 800
/** The first run's intro plays at this rate: the signature version. */
const signatureRate = 0.75

const out = 'cubic-bezier(0.22, 1, 0.36, 1)'
const inOut = 'cubic-bezier(0.45, 0, 0.25, 1)'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
const finished = (animations: readonly Animation[]) =>
  Promise.allSettled(animations.map((animation) => animation.finished))

interface Show {
  /** Plays the first run's signature version: a slower intro in full, the rule drawn beneath. */
  signature(): void
  /** Settles the wordmark and fades the overlay into the app; true once it has gone, false when cancelled. */
  reveal(): Promise<boolean>
  cancel(): void
}

/**
 * Animates the splash in `overlay` with the Web Animations API, transform and opacity only, so the compositor plays it
 * however busy the main thread is: a light crosses the name, each letter rises and flares as it passes, then the name
 * glows once. Held longer, the glow breathes and a rule draws out beneath until the reveal. `still` (reduced motion)
 * shows the settled wordmark and only fades. `release` hands input back to the app as the overlay fades.
 */
function play(overlay: HTMLElement, still: boolean, release: () => void): Show {
  const started = performance.now()
  const find = (selector: string) => overlay.querySelector(selector)!
  /** The light and the letters: the reveal waits for them. */
  const intro: Animation[] = []
  /** The flares cooling, the glow and the rule: not waited for. */
  const flair: Animation[] = []
  const exit: Animation[] = []
  let cancelled = false
  let signature = false
  let ruled = false
  let revealing: Promise<boolean> | undefined
  /** The reveal has begun: the show no longer changes. */
  let committed = false

  if (!still) {
    const span = travel.to - travel.from
    intro.push(
      find('[data-light]').animate(
        [
          { opacity: 0, transform: `translateX(${((travel.from - beam / 2) / beam) * 100}%)` },
          { opacity: 1, offset: 0.15 },
          { opacity: 1, offset: 0.85 },
          { opacity: 0, transform: `translateX(${((travel.to - beam / 2) / beam) * 100}%)` },
        ],
        { duration: sweep, fill: 'both' },
      ),
    )
    const lit = overlay.querySelectorAll('[data-lit]')
    overlay.querySelectorAll('[data-letter]').forEach((letter, index) => {
      const { x, width } = extents[index]
      const centre = (x + width / 2 - view.x) / view.width
      const delay = Math.max(0, (sweep * (centre - travel.from)) / span - lead)
      intro.push(
        letter.animate(
          [
            { opacity: 0, transform: 'translateY(14%)' },
            { opacity: 1, transform: 'none' },
          ],
          { delay, duration: rise, easing: out, fill: 'both' },
        ),
      )
      flair.push(
        lit[index].animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], {
          delay,
          duration: cool,
          easing: 'ease-out',
          fill: 'both',
        }),
      )
    })
    // As the light leaves the name, it glows once and settles.
    const glow = find('[data-glow]')
    const pulse = glow.animate(
      [
        { opacity: 0, transform: 'scale(0.97)' },
        { opacity: 1, transform: 'scale(1.015)', offset: 0.3 },
        { opacity: 0.4, transform: 'none' },
      ],
      { delay: sweep * 0.8, duration: 1000, easing: inOut, fill: 'both' },
    )
    flair.push(pulse)
    // Still loading once it has played: the glow breathes and the rule says so.
    // oxlint-disable-next-line typescript/no-floating-promises -- finished uses allSettled to consume animation cancellations; breathe and rule start only synchronous animations.
    void finished([...intro, pulse]).then(() => {
      if (committed || cancelled) return
      flair.push(
        glow.animate([{ opacity: 0.4 }, { opacity: 0.75 }], {
          duration: 1600,
          direction: 'alternate',
          easing: inOut,
          iterations: Infinity,
        }),
      )
      rule()
    })
  }

  function rule() {
    if (ruled || cancelled) return
    ruled = true
    flair.push(
      find('[data-rule]').animate(
        [
          { opacity: 0, transform: 'scaleX(0)' },
          { opacity: 1, transform: 'scaleX(1)' },
        ],
        { duration: 800, easing: out, fill: 'both' },
      ),
    )
  }

  function cancel() {
    cancelled = true
    for (const animation of [...intro, ...flair, ...exit]) animation.cancel()
  }

  return {
    signature() {
      if (signature || committed || still) return
      signature = true
      for (const animation of [...intro, ...flair]) animation.updatePlaybackRate(signatureRate)
      // oxlint-disable-next-line typescript/no-floating-promises -- finished uses allSettled to consume animation cancellations; rule starts only a synchronous animation.
      void finished(intro).then(() => rule())
    },
    reveal() {
      revealing ??= (async () => {
        // The first run's signature may still arrive meanwhile.
        const left = () => (still ? minimum.still : minimum.motion) - (performance.now() - started)
        while (left() > 0) await wait(left())
        if (cancelled) return false
        committed = true
        /** The app takes input from here on, as it comes up. */
        const handOver = () => {
          overlay.dataset.revealing = ''
          release()
        }
        // Nobody is watching: skip the show.
        if (document.hidden) {
          handOver()
          return true
        }
        // A sweep still under way finishes at its own pace: it is short, and a rush would look like a stumble.
        await finished(intro)
        if (cancelled) return false
        handOver()
        const mark = find('[data-mark]')
        const fade = [{ opacity: 1 }, { opacity: 0 }]
        if (still) exit.push(overlay.animate(fade, { duration: 180, fill: 'both' }))
        else if (signature)
          // Hands over to onboarding's first page: the name lifts away as the page beneath comes up.
          exit.push(
            mark.animate(
              [
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: 'translateY(-6%) scale(0.94)' },
              ],
              { duration: 560, easing: inOut, fill: 'both' },
            ),
            overlay.animate(fade, { delay: 140, duration: 640, easing: inOut, fill: 'both' }),
          )
        else
          exit.push(
            mark.animate(
              [
                { opacity: 1, transform: 'none' },
                { opacity: 0, transform: 'scale(1.04)' },
              ],
              { duration: 320, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' },
            ),
            overlay.animate(fade, { delay: 60, duration: 380, easing: out, fill: 'both' }),
          )
        await finished(exit)
        return !cancelled
      })()
      return revealing
    },
    cancel,
  }
}

/** F5 and Ctrl/Cmd+R: reloading stays possible while the splash covers, for a load that hangs. */
const reloads = (event: KeyboardEvent) =>
  event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')

/** Keeps a key from everything after it, its default action included, except the browser's reload. */
function swallow(event: KeyboardEvent) {
  event.stopImmediatePropagation()
  if (!reloads(event)) event.preventDefault()
}

/**
 * Keeps input from the app beneath while `overlay` covers it, a dialog included: the overlay holds focus and takes every
 * key before the app's own listeners (the shell starts its shortcuts after it, once ready). Focus the app asks for
 * meanwhile, such as the composer or a dialog's first button, is remembered; the returned release hands it back.
 */
function shield(overlay: HTMLElement) {
  let wanted = document.activeElement === document.body ? undefined : document.activeElement
  let holding = false
  const hold = (event: FocusEvent) => {
    // A dialog's focus trap may pull focus straight back: it wins, and its keys still stop here.
    if (holding || !(event.target instanceof Element) || overlay.contains(event.target)) return
    wanted = event.target
    holding = true
    overlay.focus({ preventScroll: true })
    holding = false
  }
  document.addEventListener('focusin', hold, true)
  window.addEventListener('keydown', swallow, true)
  window.addEventListener('keyup', swallow, true)
  overlay.focus({ preventScroll: true })
  let released = false
  return () => {
    if (released) return
    released = true
    document.removeEventListener('focusin', hold, true)
    window.removeEventListener('keydown', swallow, true)
    window.removeEventListener('keyup', swallow, true)
    if (wanted instanceof HTMLElement && wanted.isConnected) wanted.focus({ preventScroll: true })
  }
}

/**
 * `?splash` holds the splash on screen to polish it, automated browsers included, and a click replays it;
 * `?splash=first` plays the first run's signature version.
 */
const rehearsal = new URLSearchParams(location.search).get('splash')

/** The splash, played again on each click while rehearsing. */
function Overlay() {
  const [take, setTake] = useState(0)
  return (
    <Splash
      key={take}
      replay={rehearsal === null ? undefined : () => setTake((current) => current + 1)}
    />
  )
}

/** The ULTIMATE wordmark over the whole window until the page is ready, then the app. */
function Splash({ replay }: { replay?: () => void }) {
  const { ready, timedOut } = useReady()
  // Mounted once the page is ready, as on a very warm start or a hot reload, on a reload that shows the previous
  // page's view meanwhile, or driven by automation such as the agent's browser tool: nothing to show.
  const [gone, setGone] = useState(!replay && (ready || resumed || navigator.webdriver))
  const [still] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const overlay = useRef<HTMLDivElement>(null)
  const show = useRef<Show>(undefined)

  useLayoutEffect(() => {
    if (!overlay.current) return undefined
    const release = shield(overlay.current)
    const current = play(overlay.current, still, release)
    show.current = current
    // The first run plays the signature version, then hands over to onboarding's first page.
    let active = true
    api.action(StatusAction).then(
      (status) => {
        if (active && (status.firstRun || rehearsal === 'first')) current.signature()
      },
      // Without onboarding there is no first run.
      () => {},
    )
    return () => {
      active = false
      current.cancel()
      release()
    }
  }, [still])

  useEffect(() => {
    if (gone || !ready || rehearsal !== null) return
    void show.current
      ?.reveal()
      .then((done) => {
        if (done) setGone(true)
      })
      .catch((error: unknown) => {
        store.notify({ level: 'error', message: errorMessage(error) })
        setGone(true)
      })
  }, [gone, ready])

  if (gone) return timedOut ? <Late /> : null
  return (
    <div
      aria-busy="true"
      aria-label="Loading Ultimate"
      aria-live="polite"
      // Takes the clicks itself, even under a modal dialog's `pointer-events: none` on the body.
      className="pointer-events-auto fixed inset-0 z-[60] grid place-items-center bg-background outline-none data-revealing:pointer-events-none"
      onClick={replay}
      ref={overlay}
      role="progressbar"
      tabIndex={-1}
    >
      <div className="relative w-[min(72vw,40rem)]" data-mark="">
        <Wordmark still={still} />
        <div
          className="relative mx-auto mt-[7%] h-px w-1/4 overflow-hidden bg-foreground/10 opacity-0"
          data-rule=""
        ></div>
      </div>
    </div>
  )
}

const names = (list: readonly string[]) =>
  list.map((name, index) => (
    <span key={name}>
      {index > 0 && ', '}
      <span className="text-foreground">{name}</span>
    </span>
  ))

/** After the timeout: what had not loaded, until it has or the notice is dismissed. */
function Late() {
  const { failed, pending } = useReady()
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || (pending.length === 0 && failed.length === 0)) return null
  return (
    <div
      className="fixed top-12 left-1/2 z-40 flex w-96 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-start gap-2 rounded-md border border-border/80 bg-popover px-2.5 py-2 font-mono text-[11.5px] leading-snug shadow-lg"
      role="alert"
    >
      <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 text-foreground/90">
        <p>Not ready after {timeout / 1000} s, so it opened anyway.</p>
        <p className="mt-0.5 text-muted-foreground">
          {pending.length > 0 && <>still loading: {names(pending)}. </>}
          {failed.length > 0 && <>failed: {names(failed)}. </>}
        </p>
      </div>
      <button
        aria-label="Dismiss"
        className="shrink-0 text-muted-foreground/60 hover:text-foreground"
        onClick={() => setDismissed(true)}
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}

export default defineWebExtension({ slots: { overlay: Overlay } })
