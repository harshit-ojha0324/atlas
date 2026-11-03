// Atlas's mark: an armillary sphere (horizon, meridian, and the ecliptic at the
// 23.5° axial tilt) resting on the curve of the titan's shoulders.
function Sphere({ className, strokeWidth = 1.4, title }) {
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <circle cx="50" cy="44" r="34" />
      <ellipse cx="50" cy="44" rx="34" ry="9" />
      <ellipse cx="50" cy="44" rx="11" ry="34" />
      <ellipse cx="50" cy="44" rx="34" ry="12" transform="rotate(-23.5 50 44)" className="sphere-ecliptic" />
      <circle cx="50" cy="44" r="2.6" fill="currentColor" stroke="none" />
      <path d="M20 95 Q50 66 80 95" />
    </svg>
  );
}

export default Sphere;
