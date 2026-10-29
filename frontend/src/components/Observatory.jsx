// A lightweight, code-native celestial instrument. Decorative only: the
// interface and its data never depend on this illustration or its motion.
export default function Observatory({ className = '' }) {
  return (
    <div className={`observatory ${className}`} aria-hidden="true">
      <div className="orbital-glow" />
      <svg viewBox="0 0 480 480" fill="none">
        <g className="instrument-guides" stroke="currentColor">
          <circle cx="240" cy="240" r="213" strokeDasharray="1 9" />
          <circle cx="240" cy="240" r="195" />
          <path d="M240 14v33m0 386v33M14 240h33m386 0h33M89 89l16 16m270 270 16 16M89 391l16-16m270-270 16-16" />
          <path d="M240 68v344M68 240h344" strokeDasharray="2 8" />
        </g>
        <g className="celestial-globe" stroke="currentColor">
          <circle cx="240" cy="240" r="144" strokeWidth="1.2" />
          <ellipse cx="240" cy="240" rx="144" ry="49" />
          <ellipse cx="240" cy="240" rx="144" ry="103" />
          <ellipse cx="240" cy="240" rx="49" ry="144" />
          <ellipse cx="240" cy="240" rx="103" ry="144" />
          <path d="M96 240h288M240 96v288" />
        </g>
        <g className="celestial-orbit" stroke="currentColor">
          <ellipse cx="240" cy="240" rx="189" ry="65" transform="rotate(-32 240 240)" strokeWidth="1.5" />
          <ellipse cx="240" cy="240" rx="173" ry="164" transform="rotate(-32 240 240)" strokeWidth=".7" />
          <circle cx="399" cy="150" r="5" fill="currentColor" stroke="none" />
          <circle cx="81" cy="330" r="3" fill="currentColor" stroke="none" />
        </g>
        <g className="instrument-labels" fill="currentColor" textAnchor="middle">
          <text x="240" y="60">
            N
          </text>
          <text x="240" y="430">
            S
          </text>
          <text x="56" y="244">
            W
          </text>
          <text x="423" y="244">
            E
          </text>
          <text x="240" y="26" className="instrument-title">
            A T L A S · C E L E S T I A L A R C H I V E
          </text>
        </g>
        <circle cx="240" cy="240" r="4" fill="currentColor" />
        <path d="M230 240h20m-10-10v20" stroke="currentColor" />
      </svg>
      <span className="orbital-caption">THE WEIGHT OF KNOWLEDGE. LIFTED.</span>
    </div>
  );
}
