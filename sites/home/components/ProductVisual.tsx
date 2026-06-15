type ProductVisualProps = {
  screenshotSrc?: string;
  screenshotAlt?: string;
};

function CssIdeMock() {
  return (
    <>
      <div className="product-visual__titlebar">
        <div className="product-visual__dots" aria-hidden="true">
          <span /><span /><span />
        </div>
        <strong>Tantalum IDE</strong>
        <span className="ui-badge ui-badge--success">Cloud connected</span>
      </div>
      <div className="product-visual__body">
        <aside className="product-visual__sidebar">
          <div className="product-visual__row active"><span className="dot" /> main.ino</div>
          <div className="product-visual__row"><span className="dot" style={{ background: 'var(--text-muted)' }} /> firmware.h</div>
          <div className="product-visual__row"><span className="dot" style={{ background: 'var(--text-muted)' }} /> boards.json</div>
          <div className="product-visual__row"><span className="dot" style={{ background: 'var(--text-muted)' }} /> TantalumCloudRuntime.h</div>
        </aside>
        <main className="product-visual__editor">
          <div><span className="kw">#include</span> <span className="str">&lt;TantalumCloudRuntime.h&gt;</span></div>
          <br />
          <div><span className="ty">void</span> <span className="fn">setup</span>() {'{'}</div>
          <div>&nbsp;&nbsp;<span className="fn">Tantalum</span>.begin();</div>
          <div>&nbsp;&nbsp;<span className="fn">pinMode</span>(LED_BUILTIN, OUTPUT);</div>
          <div>{'}'}</div>
          <br />
          <div><span className="ty">void</span> <span className="fn">loop</span>() {'{'}</div>
          <div>&nbsp;&nbsp;<span className="fn">Tantalum</span>.heartbeat();</div>
          <div>&nbsp;&nbsp;<span className="fn">Tantalum</span>.checkForUpdate();</div>
          <div>{'}'}</div>
        </main>
        <aside className="product-visual__sidebar">
          <div className="product-visual__row"><span className="dot" /> ESP32 Lab</div>
          <div className="product-visual__row"><span className="dot" style={{ background: 'var(--warning)' }} /> OTA pending</div>
          <div className="product-visual__row">Runtime 1.0.0</div>
          <div className="product-visual__row">Fast agent ready</div>
        </aside>
      </div>
    </>
  );
}

export function ProductVisual({ screenshotSrc, screenshotAlt = 'Tantalum IDE screenshot' }: ProductVisualProps) {
  return (
    <div className="product-frame" aria-label="Tantalum IDE product preview">
      {screenshotSrc ? (
        <>
          <div className="product-visual__titlebar">
            <div className="product-visual__dots" aria-hidden="true">
              <span /><span /><span />
            </div>
            <strong>Tantalum IDE</strong>
          </div>
          <img className="product-screenshot" src={screenshotSrc} alt={screenshotAlt} />
        </>
      ) : (
        <CssIdeMock />
      )}
    </div>
  );
}
