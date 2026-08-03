import { createContext, useContext, useState, ReactNode } from 'react'

export interface GameConfig {
  numQuestions: number
  category: string
  difficulty: string
  source: 'open-trivia' | 'custom' | 'mixed'
}

export interface GameResult {
  correctAnswers: number
  totalQuestions: number
  score: number
}

interface GameContextType {
  config: GameConfig
  setConfig: (c: GameConfig) => void
  result: GameResult
  setResult: (r: GameResult) => void
  resetGame: () => void
}

const defaultConfig: GameConfig = {
  numQuestions: 10,
  category: 'any',
  difficulty: 'any',
  source: 'open-trivia',
}

const defaultResult: GameResult = {
  correctAnswers: 8,
  totalQuestions: 10,
  score: 160,
}

export const GameContext = createContext<GameContextType>({
  config: defaultConfig,
  setConfig: () => {},
  result: defaultResult,
  setResult: () => {},
  resetGame: () => {},
})

export function GameProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<GameConfig>(defaultConfig)
  const [result, setResult] = useState<GameResult>(defaultResult)

  const resetGame = () => {
    setResult({ correctAnswers: 0, totalQuestions: config.numQuestions, score: 0 })
  }

  return (
    <GameContext.Provider value={{ config, setConfig, result, setResult, resetGame }}>
      {children}
    </GameContext.Provider>
  )
}

export function useGame() {
  return useContext(GameContext)
}

export const MOCK_QUESTIONS = [
  {
    id: 1,
    category: 'Science',
    difficulty: 'Medium',
    question: 'What is the powerhouse of the cell?',
    options: ['Nucleus', 'Mitochondria', 'Ribosome', 'Endoplasmic Reticulum'],
    correct: 'Mitochondria',
  },
  {
    id: 2,
    category: 'History',
    difficulty: 'Easy',
    question: 'In which year did World War II end?',
    options: ['1943', '1944', '1945', '1946'],
    correct: '1945',
  },
  {
    id: 3,
    category: 'Geography',
    difficulty: 'Medium',
    question: 'What is the capital of Australia?',
    options: ['Sydney', 'Melbourne', 'Canberra', 'Brisbane'],
    correct: 'Canberra',
  },
  {
    id: 4,
    category: 'Science',
    difficulty: 'Hard',
    question: 'What is the chemical symbol for Gold?',
    options: ['Go', 'Gd', 'Au', 'Ag'],
    correct: 'Au',
  },
  {
    id: 5,
    category: 'Art & Culture',
    difficulty: 'Easy',
    question: 'Who painted the Mona Lisa?',
    options: ['Michelangelo', 'Raphael', 'Donatello', 'Leonardo da Vinci'],
    correct: 'Leonardo da Vinci',
  },
  {
    id: 6,
    category: 'Technology',
    difficulty: 'Medium',
    question: 'What does "HTTP" stand for?',
    options: [
      'HyperText Transfer Protocol',
      'High-Tech Transfer Process',
      'HyperText Transmission Protocol',
      'Home Tool Transfer Protocol',
    ],
    correct: 'HyperText Transfer Protocol',
  },
  {
    id: 7,
    category: 'Science',
    difficulty: 'Easy',
    question: 'How many planets are in our Solar System?',
    options: ['7', '8', '9', '10'],
    correct: '8',
  },
  {
    id: 8,
    category: 'History',
    difficulty: 'Medium',
    question: 'Who was the first President of the United States?',
    options: ['John Adams', 'Thomas Jefferson', 'George Washington', 'Benjamin Franklin'],
    correct: 'George Washington',
  },
  {
    id: 9,
    category: 'Mathematics',
    difficulty: 'Medium',
    question: 'What is the value of π (Pi) to 2 decimal places?',
    options: ['3.12', '3.14', '3.16', '3.18'],
    correct: '3.14',
  },
  {
    id: 10,
    category: 'Literature',
    difficulty: 'Hard',
    question: 'Who wrote "Crime and Punishment"?',
    options: ['Leo Tolstoy', 'Anton Chekhov', 'Fyodor Dostoevsky', 'Ivan Turgenev'],
    correct: 'Fyodor Dostoevsky',
  },
]

export const LEADERBOARD_DATA = [
  { rank: 1, name: 'Alex Chen', score: '98%', initials: 'AC' },
  { rank: 2, name: 'Priya Patel', score: '95%', initials: 'PP' },
  { rank: 3, name: 'Marcus Johnson', score: '90%', initials: 'MJ' },
  { rank: 4, name: 'Sophie Williams', score: '88%', initials: 'SW' },
  { rank: 5, name: 'Hiroshi Tanaka', score: '85%', initials: 'HT' },
  { rank: 6, name: 'Elena Rodriguez', score: '82%', initials: 'ER' },
  { rank: 7, name: "James O'Brien", score: '78%', initials: 'JO' },
  { rank: 8, name: 'Fatima Al-Hassan', score: '75%', initials: 'FA' },
  { rank: 9, name: 'Noah Smith', score: '70%', initials: 'NS' },
  { rank: 10, name: 'Yuki Nakamura', score: '68%', initials: 'YN' },
]
