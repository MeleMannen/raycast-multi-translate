import googleTranslate from '@iamtraction/google-translate'
import { execa } from 'execa'
import { LRUCache } from 'lru-cache'
import type { LanguageCode } from '../data/languages'
import type { TranslateResult } from '../types'

export const AUTO_DETECT = 'auto'

const cache = new LRUCache<string, TranslateResult>({
  max: 1000,
})

export class TranslateError extends Error {
  constructor(message?: string | Error, name?: string) {
    if (message instanceof Error) {
      super(message.message)
      this.name = name || message.name
    }
    else {
      super(message)
      this.name = name || this.name
    }
  }
}

// Retry malformed or rate-limited Node responses through curl against the same JSON endpoint.
async function translateWithCurl(text: string, from: LanguageCode, to: LanguageCode): Promise<Awaited<ReturnType<typeof googleTranslate>>> {
  const baseUrl = 'https://translate.google.com/translate_a/single'
  const query = new URLSearchParams()
  const parameters: [string, string | string[]][] = [
    ['client', 'gtx'],
    ['sl', from],
    ['tl', to],
    ['hl', to],
    ['dt', ['at', 'bd', 'ex', 'ld', 'md', 'qca', 'rw', 'rm', 'ss', 't']],
    ['ie', 'UTF-8'],
    ['oe', 'UTF-8'],
    ['otf', '1'],
    ['ssel', '0'],
    ['tsel', '0'],
    ['kc', '7'],
    ['q', text],
  ]

  for (const [key, value] of parameters) {
    if (Array.isArray(value))
      value.forEach(item => query.append(key, item))
    else
      query.append(key, value)
  }

  const args = ['--silent', '--show-error', '--fail-with-body', '--max-time', '15']
  const url = `${baseUrl}?${query}`

  if (url.length > 2048) {
    query.delete('q')
    args.push('--data-urlencode', `q=${text}`, `${baseUrl}?${query}`)
  }
  else {
    args.push(url)
  }

  let stdout: string
  try {
    ({ stdout } = await execa('curl', args, { timeout: 20_000 }))
  }
  catch {
    throw new TranslateError('Google Translate is temporarily unavailable. Please try again later.')
  }

  let response: unknown
  try {
    response = JSON.parse(stdout)
  }
  catch (err) {
    if (!(err instanceof SyntaxError))
      throw err
    throw new TranslateError('Google Translate returned a malformed response.')
  }

  if (!Array.isArray(response) || !Array.isArray(response[0]))
    throw new TranslateError('Google Translate returned a malformed response.')

  const translatedText = response[0]
    .filter((sentence): sentence is unknown[] => Array.isArray(sentence))
    .map(sentence => sentence[0])
    .filter((part): part is string => typeof part === 'string')
    .join('')

  if (!translatedText)
    throw new TranslateError('Google Translate returned an empty response.')

  const detectedLanguage = response[2]
  const suggestedLanguage = Array.isArray(response[8]) && Array.isArray(response[8][0])
    ? response[8][0][0]
    : undefined
  const didYouMean = typeof detectedLanguage === 'string'
    && typeof suggestedLanguage === 'string'
    && detectedLanguage !== suggestedLanguage
  const sourceLanguage = didYouMean
    ? from
    : typeof detectedLanguage === 'string'
      ? detectedLanguage as LanguageCode
      : from

  return {
    text: translatedText,
    from: {
      language: {
        didYouMean,
        iso: sourceLanguage,
      },
      text: {
        autoCorrected: false,
        value: '',
        didYouMean: false,
      },
    },
    raw: '',
  }
}

function shouldRetryWithCurl(err: unknown) {
  return err instanceof SyntaxError
    || (err instanceof Error
      && err.name === 'TranslateResponseError'
      && 'code' in err
      && (err.code === 429 || err.code === 502))
}

export async function translate(text: string, from: LanguageCode, to: LanguageCode): Promise<TranslateResult> {
  if (!text) {
    return {
      original: text,
      translated: '',
      from,
      to,
    }
  }

  const key = `${from}:${to}:${text}`
  const cached = cache.get(key)
  if (cached)
    return cached

  try {
    let translated: Awaited<ReturnType<typeof googleTranslate>>
    try {
      translated = await googleTranslate(text, { from, to })
    }
    catch (err) {
      if (!shouldRetryWithCurl(err))
        throw err
      translated = await translateWithCurl(text, from, to)
    }

    const result = {
      original: text,
      translated: translated.text,
      from: translated?.from?.language?.didYouMean
        ? from
        : translated?.from?.language?.iso as LanguageCode,
      to,
    }
    cache.set(key, result)
    return result
  }
  catch (err) {
    if (err instanceof Error) {
      switch (err.name) {
        case 'TooManyRequestsError':
          throw new TranslateError('please try again later', 'Too many requests')
        default:
          throw new TranslateError(err)
      }
    }

    throw err
  }
}

export async function translateAll(text: string, from: LanguageCode = 'auto', languages: LanguageCode[]) {
  if (!text)
    return []

  const result = (await Promise.all(languages.map(async to => translate(text, from, to)))).filter(i => i.translated)

  const fromLangs = new Set(result?.map(i => i.from))
  const singleSource = fromLangs.size === 1
  if (singleSource)
    return result.filter(i => i.from !== i.to && i.translated.trim().toLowerCase() !== i.original.trim().toLowerCase())
  return result
}
