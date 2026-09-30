import { createRoot } from 'react-dom/client';
import App from './App';
import { UiProvider } from './ui-preferences';
import './styles.css';
import './responsive.css';
import 'katex/dist/katex.min.css';
import './enhancements.css';
import './appearance.css';
import './syntax-highlighting.css';
import './typography.css';
import '../features/chat/navigation.css';
import '../features/chat/composer.css';
import './quiet-precision.css';
createRoot(document.getElementById('root')!).render(
  <UiProvider>
    <App />
  </UiProvider>,
);
