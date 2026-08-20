import type { BubbleConsentRequest } from '../../../shared/ipc'

interface Props {
  request: BubbleConsentRequest
  onAnswer: (allow: boolean) => void
}

/**
 * The single consent point in the bubble model. Asked when a bubble gains sites —
 * never per call — so it must state plainly what the grant actually is: these
 * sites' edits will be able to read and write each other's data, and nothing
 * outside the bubble can.
 */
export default function BubbleConsent({ request, onAnswer }: Props) {
  const { name, adding, existing } = request
  const total = existing.length + adding.length
  return (
    <div className="consent" data-testid="bubble-consent">
      <div className="consent-title">
        Allow data sharing in <strong>{name}</strong>?
      </div>

      <ul className="consent-hosts">
        {existing.map((h) => (
          <li key={h} className="already">
            {h} <span className="tag">already in</span>
          </li>
        ))}
        {adding.map((h) => (
          <li key={h} className="adding">
            {h} <span className="tag new">adding</span>
          </li>
        ))}
      </ul>

      <p className="consent-body">
        {total > 1 ? (
          <>
            Edits on {total === 2 ? 'these two sites' : `these ${total} sites`} will be able to read
            and write each other&rsquo;s data. No other site can see it, and this is the only time
            you&rsquo;ll be asked &mdash; edits inside the bubble share data without further
            prompting.
          </>
        ) : (
          <>
            This bubble will hold one site for now. Nothing is shared until a second site joins,
            which will ask you again.
          </>
        )}
      </p>

      <div className="consent-actions">
        <button className="consent-deny" onClick={() => onAnswer(false)}>
          Don&rsquo;t allow
        </button>
        <button className="consent-allow" onClick={() => onAnswer(true)} autoFocus>
          Allow sharing
        </button>
      </div>
    </div>
  )
}
