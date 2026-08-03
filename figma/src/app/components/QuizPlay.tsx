import { useState, useEffect, useContext, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { GameContext, MOCK_QUESTIONS } from './GameContext'

const TIMER_SECONDS = 15
const SCORE_PER_CORRECT = 20
const ANSWER_LABELS = ['A', 'B', 'C', 'D']

type AnswerState = 'default' | 'correct' | 'incorrect' | 'disabled'

function CircularTimer({ seconds, maxSeconds = TIMER_SECONDS }: { seconds: number; maxSeconds?: number }) {
  const radius = 18
  const circumference = 2 * Math.PI * radius
  const filled = (seconds / maxSeconds) * circumference
  const color = seconds > 7 ? '#4F46E5' : seconds > 3 ? '#B45309' : '#B91C1C'
  const trackColor = seconds > 7 ? '#E0E7FF' : seconds > 3 ? '#FFFBEB' : '#FEF2F2'

  return (
    <div
      style={{
        width: '48px',
        height: '48px',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}
        viewBox="0 0 44 44"
        width="48"
        height="48"
      >
        <circle cx="22" cy="22" r={radius} fill="none" stroke={trackColor} strokeWidth="3" />
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference - filled}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.4s ease' }}
        />
      </svg>
      <span style={{ fontSize: '11px', fontWeight: 700, color, position: 'relative', zIndex: 1 }}>
        {seconds}s
      </span>
    </div>
  )
}

function AnswerButton({
  label,
  text,
  state,
  onClick,
}: {
  label: string
  text: string
  state: AnswerState
  onClick: () => void
}) {
  const styles: Record<AnswerState, { bg: string; border: string; color: string; labelBg: string; labelColor: string }> = {
    default: {
      bg: '#FFFFFF',
      border: 'rgba(15,23,42,0.15)',
      color: '#0F172A',
      labelBg: '#F1F5F9',
      labelColor: '#64748B',
    },
    correct: {
      bg: '#F0FDF4',
      border: '#15803D',
      color: '#14532D',
      labelBg: '#15803D',
      labelColor: '#FFFFFF',
    },
    incorrect: {
      bg: '#FEF2F2',
      border: '#B91C1C',
      color: '#7F1D1D',
      labelBg: '#B91C1C',
      labelColor: '#FFFFFF',
    },
    disabled: {
      bg: '#FFFFFF',
      border: 'rgba(15,23,42,0.08)',
      color: '#94A3B8',
      labelBg: '#F1F5F9',
      labelColor: '#94A3B8',
    },
  }

  const s = styles[state]
  const isClickable = state === 'default'

  return (
    <button
      onClick={isClickable ? onClick : undefined}
      disabled={!isClickable}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 16px',
        borderRadius: '12px',
        border: `1.5px solid ${s.border}`,
        background: s.bg,
        color: s.color,
        cursor: isClickable ? 'pointer' : 'not-allowed',
        textAlign: 'left',
        width: '100%',
        transition: 'background 0.2s, border-color 0.2s, color 0.2s, box-shadow 0.15s',
        opacity: state === 'disabled' ? 0.6 : 1,
        fontFamily: 'Inter, sans-serif',
      }}
      onMouseEnter={(e) => {
        if (isClickable) {
          e.currentTarget.style.background = '#F8FAFC'
          e.currentTarget.style.borderColor = '#4F46E5'
          e.currentTarget.style.boxShadow = '0 0 0 3px rgba(79,70,229,0.08)'
        }
      }}
      onMouseLeave={(e) => {
        if (isClickable) {
          e.currentTarget.style.background = s.bg
          e.currentTarget.style.borderColor = s.border
          e.currentTarget.style.boxShadow = 'none'
        }
      }}
    >
      <span
        style={{
          width: '28px',
          height: '28px',
          borderRadius: '7px',
          background: s.labelBg,
          color: s.labelColor,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          fontWeight: 700,
          flexShrink: 0,
          transition: 'background 0.2s, color 0.2s',
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: '14px', fontWeight: 500, lineHeight: 1.4 }}>{text}</span>
    </button>
  )
}

export function QuizPlay() {
  const navigate = useNavigate()
  const { config, setResult } = useContext(GameContext)

  const totalQuestions = config.numQuestions
  const questions = MOCK_QUESTIONS.slice(0, totalQuestions)

  const [currentIndex, setCurrentIndex] = useState(0)
  const [score, setScore] = useState(0)
  const [correctCount, setCorrectCount] = useState(0)
  const [timeLeft, setTimeLeft] = useState(TIMER_SECONDS)
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)

  const currentQuestion = questions[currentIndex]

  const advanceQuestion = useCallback(() => {
    if (currentIndex + 1 >= questions.length) {
      setResult({
        correctAnswers: correctCount,
        totalQuestions: questions.length,
        score: correctCount * SCORE_PER_CORRECT,
      })
      navigate('/game-over')
    } else {
      setCurrentIndex((i) => i + 1)
      setSelectedAnswer(null)
      setRevealed(false)
      setTimeLeft(TIMER_SECONDS)
    }
  }, [currentIndex, questions.length, correctCount, navigate, setResult])

  const handleAnswer = useCallback(
    (answer: string) => {
      if (revealed) return
      setSelectedAnswer(answer)
      setRevealed(true)
      if (answer === currentQuestion.correct) {
        setCorrectCount((c) => c + 1)
        setScore((s) => s + SCORE_PER_CORRECT)
      }
    },
    [revealed, currentQuestion]
  )

  // Timer countdown
  useEffect(() => {
    if (revealed) return
    if (timeLeft <= 0) {
      setRevealed(true)
      return
    }
    const id = setTimeout(() => setTimeLeft((t) => t - 1), 1000)
    return () => clearTimeout(id)
  }, [timeLeft, revealed])

  // Auto-advance after reveal
  useEffect(() => {
    if (!revealed) return
    const id = setTimeout(advanceQuestion, 2000)
    return () => clearTimeout(id)
  }, [revealed, advanceQuestion])

  const getAnswerState = (option: string): AnswerState => {
    if (!revealed) return 'default'
    if (option === currentQuestion.correct) return 'correct'
    if (option === selectedAnswer) return 'incorrect'
    return 'disabled'
  }

  const progress = ((currentIndex) / questions.length) * 100

  const difficultyColor =
    currentQuestion.difficulty === 'Easy'
      ? { bg: '#F0FDF4', color: '#15803D' }
      : currentQuestion.difficulty === 'Hard'
      ? { bg: '#FEF2F2', color: '#B91C1C' }
      : { bg: '#F1F5F9', color: '#64748B' }

  return (
    <div
      style={{
        minHeight: 'calc(100vh - 64px)',
        background: '#F8FAFC',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 16px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '560px',
          background: '#FFFFFF',
          borderRadius: '24px',
          boxShadow: '0 8px 32px rgba(15,23,42,0.08), 0 2px 8px rgba(15,23,42,0.04)',
          overflow: 'hidden',
        }}
      >
        {/* Status Row */}
        <div
          style={{
            padding: '20px 24px 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid rgba(15,23,42,0.06)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', letterSpacing: '0.4px', textTransform: 'uppercase' }}>
              Question
            </span>
            <span style={{ fontSize: '20px', fontWeight: 800, color: '#0F172A', letterSpacing: '-0.5px', fontFamily: 'Inter, sans-serif' }}>
              {currentIndex + 1}
              <span style={{ fontSize: '14px', fontWeight: 500, color: '#94A3B8' }}> / {questions.length}</span>
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', letterSpacing: '0.4px', textTransform: 'uppercase' }}>
              Score
            </span>
            <span style={{ fontSize: '20px', fontWeight: 800, color: '#4F46E5', letterSpacing: '-0.5px', fontFamily: 'Inter, sans-serif' }}>
              {score}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748B', letterSpacing: '0.4px', textTransform: 'uppercase' }}>
              Time
            </span>
            <CircularTimer seconds={timeLeft} />
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ height: '4px', background: '#F1F5F9', position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              height: '100%',
              width: `${progress}%`,
              background: 'linear-gradient(90deg, #4F46E5, #7C3AED)',
              borderRadius: '0 4px 4px 0',
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        {/* Question Body */}
        <div style={{ padding: '24px' }}>
          {/* Pills */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', flexWrap: 'wrap' }}>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: '#4F46E5',
                background: '#E0E7FF',
                padding: '4px 10px',
                borderRadius: '999px',
                letterSpacing: '0.6px',
                textTransform: 'uppercase',
              }}
            >
              {currentQuestion.category}
            </span>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                color: difficultyColor.color,
                background: difficultyColor.bg,
                padding: '4px 10px',
                borderRadius: '999px',
                letterSpacing: '0.6px',
                textTransform: 'uppercase',
              }}
            >
              {currentQuestion.difficulty}
            </span>
          </div>

          {/* Question Text */}
          <p
            style={{
              fontSize: '20px',
              fontWeight: 700,
              color: '#0F172A',
              lineHeight: 1.45,
              margin: '0 0 24px',
              fontFamily: 'Inter, sans-serif',
              letterSpacing: '-0.2px',
            }}
          >
            {currentQuestion.question}
          </p>

          {/* Answer Grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '10px',
            }}
          >
            {currentQuestion.options.map((option, i) => (
              <AnswerButton
                key={option}
                label={ANSWER_LABELS[i]}
                text={option}
                state={getAnswerState(option)}
                onClick={() => handleAnswer(option)}
              />
            ))}
          </div>

          {/* Result Feedback */}
          {revealed && (
            <div
              style={{
                marginTop: '20px',
                padding: '12px 16px',
                borderRadius: '10px',
                background: selectedAnswer === currentQuestion.correct ? '#F0FDF4' : '#FEF2F2',
                border: `1px solid ${selectedAnswer === currentQuestion.correct ? '#BBF7D0' : '#FECACA'}`,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                animation: 'fadeIn 0.2s ease',
              }}
            >
              <span style={{ fontSize: '18px' }}>
                {selectedAnswer === currentQuestion.correct ? '🎉' : selectedAnswer === null ? '⏰' : '❌'}
              </span>
              <span
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: selectedAnswer === currentQuestion.correct ? '#15803D' : '#B91C1C',
                }}
              >
                {selectedAnswer === currentQuestion.correct
                  ? 'Correct! Well done.'
                  : selectedAnswer === null
                  ? `Time's up! The answer was ${currentQuestion.correct}.`
                  : `Incorrect. The correct answer is ${currentQuestion.correct}.`}
              </span>
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  )
}
