import { useState, useContext } from 'react'
import { useNavigate } from 'react-router'
import { Trophy, RotateCcw, Save, Medal } from 'lucide-react'
import { GameContext, LEADERBOARD_DATA } from './GameContext'

const MEDAL_COLORS: Record<number, string> = {
  1: '#F59E0B',
  2: '#94A3B8',
  3: '#B45309',
}

export function GameOver() {
  const navigate = useNavigate()
  const { result, resetGame } = useContext(GameContext)
  const [playerName, setPlayerName] = useState('Jane Doe')
  const [saved, setSaved] = useState(false)
  const [leaderboard, setLeaderboard] = useState(LEADERBOARD_DATA)
  const [playerEntry, setPlayerEntry] = useState<{ rank: number; name: string; score: string; initials: string } | null>(null)

  const accuracy = result.totalQuestions > 0
    ? Math.round((result.correctAnswers / result.totalQuestions) * 100)
    : 0

  const handleSave = () => {
    if (!playerName.trim()) return
    const initials = playerName
      .trim()
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
    const scoreStr = `${accuracy}%`
    const entry = { rank: 0, name: playerName.trim(), score: scoreStr, initials }

    const newBoard = [...LEADERBOARD_DATA, { ...entry, rank: 0 }]
      .sort((a, b) => parseInt(b.score) - parseInt(a.score))
      .map((e, i) => ({ ...e, rank: i + 1 }))
      .slice(0, 10)

    const found = newBoard.find((e) => e.name === playerName.trim() && e.score === scoreStr)
    setLeaderboard(newBoard)
    if (found) setPlayerEntry(found)
    setSaved(true)
  }

  const handlePlayAgain = () => {
    resetGame()
    navigate('/')
  }

  const performanceLabel =
    accuracy >= 90 ? 'Outstanding!' : accuracy >= 70 ? 'Great job!' : accuracy >= 50 ? 'Good effort!' : 'Keep practicing!'

  const performanceColor =
    accuracy >= 90 ? '#15803D' : accuracy >= 70 ? '#4F46E5' : accuracy >= 50 ? '#B45309' : '#B91C1C'

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 64px)',
        background: '#F8FAFC',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '520px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        {/* Header Card */}
        <div
          style={{
            background: '#FFFFFF',
            borderRadius: '24px',
            boxShadow: '0 8px 32px rgba(15,23,42,0.08), 0 2px 8px rgba(15,23,42,0.04)',
            padding: '32px 32px 28px',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '20px',
              background: 'linear-gradient(135deg, #F59E0B 0%, #FBBF24 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              boxShadow: '0 8px 24px rgba(245,158,11,0.3)',
            }}
          >
            <Trophy size={28} color="#fff" />
          </div>
          <h1
            style={{
              fontSize: '30px',
              fontWeight: 800,
              color: '#0F172A',
              margin: '0 0 6px',
              letterSpacing: '-0.5px',
              fontFamily: 'Inter, sans-serif',
            }}
          >
            Game Over!
          </h1>
          <p style={{ fontSize: '15px', color: '#64748B', margin: '0 0 24px' }}>Here's how you did</p>

          {/* Score Stats */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '16px',
            }}
          >
            {/* Score */}
            <div
              style={{
                padding: '20px',
                borderRadius: '16px',
                background: '#F8FAFC',
                border: '1px solid rgba(15,23,42,0.07)',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: '8px' }}>
                Score
              </div>
              <div
                style={{
                  fontSize: '36px',
                  fontWeight: 800,
                  color: '#4F46E5',
                  letterSpacing: '-1px',
                  fontFamily: 'Inter, sans-serif',
                  lineHeight: 1,
                  marginBottom: '4px',
                }}
              >
                {result.correctAnswers}
                <span style={{ fontSize: '20px', color: '#94A3B8', fontWeight: 500 }}>
                  {' '}/ {result.totalQuestions}
                </span>
              </div>
              <div style={{ fontSize: '13px', color: '#64748B' }}>correct answers</div>
            </div>

            {/* Accuracy */}
            <div
              style={{
                padding: '20px',
                borderRadius: '16px',
                background: '#F8FAFC',
                border: '1px solid rgba(15,23,42,0.07)',
                textAlign: 'center',
              }}
            >
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', letterSpacing: '0.5px', textTransform: 'uppercase', marginBottom: '8px' }}>
                Accuracy
              </div>
              <div
                style={{
                  fontSize: '36px',
                  fontWeight: 800,
                  color: performanceColor,
                  letterSpacing: '-1px',
                  fontFamily: 'Inter, sans-serif',
                  lineHeight: 1,
                  marginBottom: '4px',
                }}
              >
                {accuracy}%
              </div>
              <div style={{ fontSize: '13px', color: performanceColor, fontWeight: 600 }}>{performanceLabel}</div>
            </div>
          </div>
        </div>

        {/* Save Score Box */}
        {!saved ? (
          <div
            style={{
              background: '#E0E7FF',
              borderRadius: '16px',
              padding: '20px 24px',
              border: '1px solid rgba(79,70,229,0.15)',
            }}
          >
            <div style={{ fontSize: '14px', fontWeight: 700, color: '#3730A3', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Save size={15} />
              Save your score to the leaderboard
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                placeholder="Your display name"
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: '10px',
                  border: '1px solid rgba(79,70,229,0.25)',
                  background: '#FFFFFF',
                  fontSize: '14px',
                  fontWeight: 500,
                  color: '#0F172A',
                  fontFamily: 'Inter, sans-serif',
                  outline: 'none',
                  transition: 'border-color 0.15s, box-shadow 0.15s',
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = '#4F46E5'
                  e.currentTarget.style.boxShadow = '0 0 0 3px rgba(79,70,229,0.12)'
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(79,70,229,0.25)'
                  e.currentTarget.style.boxShadow = 'none'
                }}
              />
              <button
                onClick={handleSave}
                style={{
                  padding: '10px 18px',
                  borderRadius: '10px',
                  background: '#4F46E5',
                  color: '#fff',
                  border: 'none',
                  fontSize: '14px',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'Inter, sans-serif',
                  whiteSpace: 'nowrap',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#4338CA')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#4F46E5')}
              >
                Save Score
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              background: '#F0FDF4',
              borderRadius: '16px',
              padding: '16px 24px',
              border: '1px solid #BBF7D0',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <span style={{ fontSize: '20px' }}>✅</span>
            <div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#15803D' }}>Score saved!</div>
              {playerEntry && (
                <div style={{ fontSize: '13px', color: '#166534' }}>
                  You're ranked #{playerEntry.rank} on the leaderboard.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Leaderboard Card */}
        <div
          style={{
            background: '#FFFFFF',
            borderRadius: '24px',
            boxShadow: '0 8px 32px rgba(15,23,42,0.08), 0 2px 8px rgba(15,23,42,0.04)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              padding: '20px 24px 16px',
              borderBottom: '1px solid rgba(15,23,42,0.06)',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <Medal size={18} color="#F59E0B" />
            <h2
              style={{
                fontSize: '16px',
                fontWeight: 700,
                color: '#0F172A',
                margin: 0,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              Top 10 Leaderboard
            </h2>
          </div>

          <div style={{ padding: '8px 0' }}>
            {leaderboard.map((entry, i) => {
              const isCurrentPlayer = saved && playerEntry && entry.rank === playerEntry.rank && entry.name === playerEntry.name
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    padding: '10px 24px',
                    gap: '14px',
                    background: isCurrentPlayer ? '#EEF2FF' : 'transparent',
                    borderLeft: isCurrentPlayer ? '3px solid #4F46E5' : '3px solid transparent',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    if (!isCurrentPlayer) e.currentTarget.style.background = '#F8FAFC'
                  }}
                  onMouseLeave={(e) => {
                    if (!isCurrentPlayer) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {/* Rank */}
                  <div
                    style={{
                      width: '28px',
                      textAlign: 'center',
                      fontSize: entry.rank <= 3 ? '18px' : '13px',
                      fontWeight: 700,
                      color: MEDAL_COLORS[entry.rank] ?? '#94A3B8',
                      flexShrink: 0,
                    }}
                  >
                    {entry.rank <= 3 ? (entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : '🥉') : `#${entry.rank}`}
                  </div>

                  {/* Avatar */}
                  <div
                    style={{
                      width: '36px',
                      height: '36px',
                      borderRadius: '50%',
                      background: isCurrentPlayer
                        ? 'linear-gradient(135deg, #4F46E5, #7C3AED)'
                        : 'linear-gradient(135deg, #E2E8F0, #CBD5E1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: '12px',
                        fontWeight: 700,
                        color: isCurrentPlayer ? '#fff' : '#64748B',
                      }}
                    >
                      {entry.initials}
                    </span>
                  </div>

                  {/* Name */}
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontSize: '14px',
                        fontWeight: isCurrentPlayer ? 700 : 500,
                        color: isCurrentPlayer ? '#4F46E5' : '#0F172A',
                      }}
                    >
                      {entry.name}
                      {isCurrentPlayer && (
                        <span
                          style={{
                            fontSize: '10px',
                            fontWeight: 700,
                            background: '#E0E7FF',
                            color: '#4F46E5',
                            padding: '1px 6px',
                            borderRadius: '999px',
                            marginLeft: '6px',
                          }}
                        >
                          YOU
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Score */}
                  <div
                    style={{
                      fontSize: '15px',
                      fontWeight: 700,
                      color: isCurrentPlayer ? '#4F46E5' : '#0F172A',
                      fontFamily: 'Inter, sans-serif',
                    }}
                  >
                    {entry.score}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Play Again */}
        <button
          onClick={handlePlayAgain}
          style={{
            width: '100%',
            padding: '16px 24px',
            borderRadius: '16px',
            background: '#0F172A',
            color: '#FFFFFF',
            border: 'none',
            fontSize: '16px',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'Inter, sans-serif',
            letterSpacing: '0.2px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            transition: 'background 0.15s, transform 0.1s',
            boxShadow: '0 4px 16px rgba(15,23,42,0.2)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = '#1E293B'
            e.currentTarget.style.transform = 'translateY(-1px)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = '#0F172A'
            e.currentTarget.style.transform = 'translateY(0)'
          }}
        >
          <RotateCcw size={18} />
          Play Again
        </button>
      </div>
    </div>
  )
}
