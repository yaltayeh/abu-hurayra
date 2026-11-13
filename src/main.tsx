import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ReviewPage from './review/ReviewPage.tsx'

// ?view=review opens the alignment review page (QA tool); the default page is the plain transcript
const review = new URLSearchParams(window.location.search).get('view') === 'review'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {review ? <ReviewPage /> : <App />}
  </StrictMode>,
)
