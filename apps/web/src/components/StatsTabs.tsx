import { useNavigate } from 'react-router-dom';

/** Switches between the parts of Statistics: your reading, its topics, stories, the AI, and the PC's fetches. */
export function StatsTabs({ current }: { current: 'reading' | 'ai' | 'pc' | 'topics' | 'stories' }) {
  const navigate = useNavigate();
  return (
    <div className="tabs" role="tablist" aria-label="Statistics">
      <button className="pill" role="tab" aria-pressed={current === 'reading'} onClick={() => navigate('/stats', { replace: true })}>
        Reading
      </button>
      <button className="pill" role="tab" aria-pressed={current === 'topics'} onClick={() => navigate('/stats/topics', { replace: true })}>
        Topics
      </button>
      <button className="pill" role="tab" aria-pressed={current === 'stories'} onClick={() => navigate('/stats/stories', { replace: true })}>
        Stories
      </button>
      <button className="pill" role="tab" aria-pressed={current === 'ai'} onClick={() => navigate('/stats/ai', { replace: true })}>
        AI summaries
      </button>
      <button className="pill" role="tab" aria-pressed={current === 'pc'} onClick={() => navigate('/stats/pc', { replace: true })}>
        PC fetches
      </button>
    </div>
  );
}
