import { useEffect, useState } from "react";
import type { AskUserQuestionPrompt, AskUserQuestionResponse } from "../../../shared/ipc";
import { useI18n } from "../../i18n";
import { Button, Dialog, TextArea } from "../ui";

type Selection = number | "other" | null;
type SelectionMap = Record<string, Selection>;
type CustomAnswerMap = Record<string, string>;

export function AskUserQuestionDialog(props: {
  prompt: AskUserQuestionPrompt | null;
  onAnswer(response: AskUserQuestionResponse): void;
}) {
  const { t } = useI18n();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selections, setSelections] = useState<SelectionMap>({});
  const [customAnswers, setCustomAnswers] = useState<CustomAnswerMap>({});

  useEffect(() => {
    setCurrentIndex(0);
    setSelections({});
    setCustomAnswers({});
  }, [props.prompt?.id]);

  if (!props.prompt) return null;

  const questions = props.prompt.questions;
  const currentQuestion = questions[Math.min(currentIndex, questions.length - 1)];
  const currentSelection = currentQuestion ? selections[currentQuestion.id] ?? null : null;
  const isLastQuestion = currentIndex >= questions.length - 1;
  const currentCanContinue = Boolean(currentQuestion && (
    currentSelection === "other"
      ? (customAnswers[currentQuestion.id] ?? "").trim()
      : typeof currentSelection === "number" && currentQuestion.options[currentSelection]
  ));
  const canSubmit = props.prompt.questions.every((question) => {
    const selection = selections[question.id] ?? null;
    if (selection === "other") return Boolean((customAnswers[question.id] ?? "").trim());
    return typeof selection === "number" && Boolean(question.options[selection]);
  });

  function setSelection(questionId: string, selection: Selection) {
    setSelections((current) => ({ ...current, [questionId]: selection }));
  }

  function setCustomAnswer(questionId: string, value: string) {
    setCustomAnswers((current) => ({ ...current, [questionId]: value }));
  }

  function continueFromCurrentQuestion() {
    if (!currentCanContinue) return;
    if (!isLastQuestion) {
      setCurrentIndex((index) => Math.min(index + 1, questions.length - 1));
      return;
    }
    submit();
  }

  function submit() {
    if (!props.prompt || !canSubmit) return;
    props.onAnswer({
      id: props.prompt.id,
      answers: props.prompt.questions.map((question) => {
        const selection = selections[question.id] ?? null;
        if (selection === "other") {
          return {
            questionId: question.id,
            question: question.question,
            answer: (customAnswers[question.id] ?? "").trim(),
            custom: true
          };
        }
        const selectedIndex = typeof selection === "number" ? selection : -1;
        const option = question.options[selectedIndex];
        return {
          questionId: question.id,
          question: question.question,
          answer: option.label,
          custom: false,
          selectedIndex: selectedIndex + 1,
          selectedOptionLabel: option.label
        };
      })
    });
  }

  return (
    <Dialog
      className="ask-user-question-dialog"
      closeOnOutside={false}
      onClose={() => undefined}
      open={Boolean(props.prompt)}
      showClose={false}
      title={t("askUserQuestion.title")}
      body={<p>{t("askUserQuestion.waiting")}</p>}
      actions={(
        <>
          {currentIndex > 0 ? (
            <Button type="button" onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}>
              {t("askUserQuestion.back")}
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={isLastQuestion ? !canSubmit : !currentCanContinue} form="ask-user-question-form">
            {isLastQuestion ? t("askUserQuestion.submit") : t("askUserQuestion.next")}
          </Button>
        </>
      )}
    >
      <form
        id="ask-user-question-form"
        className="ask-user-question-form"
        onSubmit={(event) => {
          event.preventDefault();
          continueFromCurrentQuestion();
        }}
      >
        {currentQuestion ? (
          <section className="ask-user-question-item" key={currentQuestion.id} aria-labelledby={`ask-user-question-${props.prompt.id}-${currentQuestion.id}-label`}>
            <div className="ask-user-question-progress">
              {t("askUserQuestion.progress", { current: currentIndex + 1, total: questions.length })}
            </div>
            <div className="ask-user-question-header">{currentQuestion.header}</div>
            <div id={`ask-user-question-${props.prompt.id}-${currentQuestion.id}-label`} className="ask-user-question-prompt">{currentQuestion.question}</div>
            <div className="ask-user-question-options" role="radiogroup" aria-label={currentQuestion.question}>
              {currentQuestion.options.map((option, index) => (
                <Button
                  variant="quiet"
                  type="button"
                  key={`${props.prompt?.id}:${currentQuestion.id}:${index}:${option.label}`}
                  className={`ask-user-question-option ${currentSelection === index ? "selected" : ""}`}
                  role="radio"
                  aria-checked={currentSelection === index}
                  onClick={() => setSelection(currentQuestion.id, index)}
                >
                  <span>{option.label}</span>
                  {option.description ? <small>{option.description}</small> : null}
                </Button>
              ))}
              <Button
                variant="quiet"
                type="button"
                className={`ask-user-question-option ${currentSelection === "other" ? "selected" : ""}`}
                role="radio"
                aria-checked={currentSelection === "other"}
                onClick={() => setSelection(currentQuestion.id, "other")}
              >
                <span>{t("askUserQuestion.other")}</span>
                <small>{t("askUserQuestion.otherDescription")}</small>
              </Button>
            </div>
            {currentSelection === "other" ? (
              <TextArea
                aria-label={`${t("askUserQuestion.customAnswer")} - ${currentQuestion.header}`}
                value={customAnswers[currentQuestion.id] ?? ""}
                onChange={(event) => setCustomAnswer(currentQuestion.id, event.target.value)}
                placeholder={t("askUserQuestion.customPlaceholder")}
                rows={3}
              />
            ) : null}
          </section>
        ) : null}
      </form>
    </Dialog>
  );
}
