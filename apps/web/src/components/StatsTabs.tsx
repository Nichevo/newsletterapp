import { useNavigate } from 'react-router-dom';

/** Switches between the two halves of Statistics: your reading, and the AI. */
export function StatsTabs({ current }: { current: 'reading' | 'ai' }) {
  const navigate = useNavigate();
  return (
    <div className="tabs" role="tablist" aria-label="Statistics">
      <button className="pill" role="tab" aria-pressed={current === 'reading'} onClick={() => navigate('/stats', { replace: true })}>
        Reading
      </button>
      <button className="pill" role="tab" aria-pressed={current === 'ai'} onClick={() => navigate('/stats/ai', { replace: true })}>
        AI summaries
      </button>
    </div>
  );
}
