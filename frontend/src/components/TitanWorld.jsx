// Everything only the easter egg needs, in one chunk that nobody else downloads.
import '@fontsource-variable/cinzel';
import titanCss from '../titan.css?inline';
import TitanScene from './TitanScene';

function TitanWorld(props) {
  return (
    <>
      <style>{titanCss}</style>
      <TitanScene {...props} />
    </>
  );
}

export default TitanWorld;
