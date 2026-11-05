import { createContext, useContext } from 'react';

// One interface, two looks. "pro" is what everyone gets. "titan" is the easter
// egg: seven clicks on the name on the sign-in screen, and the same components
// are drawn by titan.css in front of TitanScene. Kept per tab, like the API key.
const KEY = 'atlas.theme';

export const savedTheme = () => (sessionStorage.getItem(KEY) === 'titan' ? 'titan' : 'pro');
export const saveTheme = (theme) => sessionStorage.setItem(KEY, theme);

export const ThemeContext = createContext('pro');
export const useTheme = () => useContext(ThemeContext);

const COPY = {
  pro: {
    signinTitle: ['Answers you can check.', 'Every claim links to its page.'],
    hero: ['Ask your documents.', null],
    heroText: 'Answers come only from your library, and every claim links to the page it came from.',
    noDocuments: 'Your library is empty.',
    threadTitle: 'Conversation',
    thinking: 'Reading your documents…',
    libraryTitle: 'Library',
    libraryLede: 'Everything Atlas can answer from. Only your workspace can see these documents.',
    dropTitle: 'Upload a PDF',
    dropBusy: 'Uploading…',
    libraryEmpty: 'No documents yet.',
  },
  titan: {
    signinTitle: ['He holds up the sky.', 'You ask the questions.'],
    hero: ['The weight of knowledge.', 'Lifted.'],
    heroText:
      'Give Atlas your documents. Ask what you need to know, and follow every answer back to the page it came from.',
    noDocuments: 'Atlas has nothing to carry yet.',
    threadTitle: 'Atlas answers.',
    thinking: 'Atlas is reading your documents…',
    libraryTitle: 'What Atlas carries.',
    libraryLede: 'Every answer stands on these documents. Add one and it joins the stars.',
    dropTitle: 'Give Atlas something to carry.',
    dropBusy: 'Taking up the weight…',
    libraryEmpty: 'Nothing to carry yet.',
  },
};

export const useCopy = () => COPY[useTheme()];
