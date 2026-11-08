const LIMITS = { name: 100, phone: 50, message: 2000 };

const form = document.getElementById("lead-form");
const receipt = document.getElementById("receipt");
const alertBox = document.getElementById("form-alert");
const submit = document.getElementById("submit");
const message = document.getElementById("message");
const messageCount = document.getElementById("message-count");

const charCount = (text) => [...text].length;
const errorElement = (field) => document.getElementById(`${field}-error`);

function controlsFor(field) {
  return field === "service" ? [...form.querySelectorAll('input[name="service"]')] : [form.elements[field]];
}

function showFieldError(field, text) {
  const error = errorElement(field);
  error.textContent = text;
  error.hidden = false;
  for (const control of controlsFor(field)) control.setAttribute("aria-invalid", "true");
}

function clearFieldError(field) {
  errorElement(field).hidden = true;
  for (const control of controlsFor(field)) control.removeAttribute("aria-invalid");
}

function clearErrors() {
  alertBox.hidden = true;
  for (const field of ["name", "email", "phone", "service", "message"]) clearFieldError(field);
}

function readForm() {
  const data = new FormData(form);
  return {
    name: data.get("name"),
    email: data.get("email"),
    phone: data.get("phone"),
    service: data.get("service") ?? "",
    message: data.get("message"),
  };
}

/** Quick checks for instant feedback. The server applies the full rules. */
function checkLead(lead) {
  const errors = {};
  if (!lead.name.trim()) errors.name = "Enter your name.";
  else if (charCount(lead.name) > LIMITS.name) errors.name = `Keep your name to ${LIMITS.name} characters.`;
  if (!lead.email.trim()) errors.email = "Enter your email address.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.email = "Enter an email address like ana@example.com.";
  if (charCount(lead.phone) > LIMITS.phone) errors.phone = `Keep your phone number to ${LIMITS.phone} characters.`;
  if (!lead.service) errors.service = "Choose a type of service.";
  if (!lead.message.trim()) errors.message = "Tell us about the job.";
  else if (charCount(lead.message) > LIMITS.message) errors.message = `Keep this to ${LIMITS.message} characters.`;
  return errors;
}

function focusField(field) {
  controlsFor(field)[0].focus();
}

function updateMessageCount() {
  const used = charCount(message.value);
  messageCount.textContent = `${used} of ${LIMITS.message} characters`;
  messageCount.classList.toggle("over", used > LIMITS.message);
}

function setSending(sending) {
  submit.disabled = sending;
  submit.classList.toggle("is-busy", sending);
  submit.textContent = sending ? "Sending request" : "Send request";
}

function showReceipt(lead) {
  document.getElementById("receipt-title").textContent = `Thanks, ${lead.name}.`;
  document.getElementById("receipt-detail").textContent = `Your request number is ${lead.id}. We'll reply to ${lead.email}.`;
  form.hidden = true;
  receipt.hidden = false;
  receipt.focus();
}

/* Errors appear when someone leaves a field they've filled in, and clear as soon as it's fixed. */
for (const field of ["name", "email", "phone", "message"]) {
  const control = form.elements[field];
  control.addEventListener("blur", () => {
    if (!control.value) return;
    const error = checkLead(readForm())[field];
    if (error) showFieldError(field, error);
  });
  control.addEventListener("input", () => {
    if (errorElement(field).hidden) return;
    const error = checkLead(readForm())[field];
    if (error) showFieldError(field, error);
    else clearFieldError(field);
  });
}

form.addEventListener("change", (event) => {
  if (event.target.name === "service") clearFieldError("service");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submit.disabled) return;
  clearErrors();

  const lead = readForm();
  const errors = Object.entries(checkLead(lead));
  if (errors.length) {
    for (const [field, text] of errors) showFieldError(field, text);
    focusField(errors[0][0]);
    return;
  }

  setSending(true);
  try {
    const response = await fetch("/api/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
    const body = await response.json();
    if (response.status === 201) {
      showReceipt(body);
      return;
    }
    const field = body.error?.match(/^(name|email|phone|service|message)\b/)?.[1];
    if (field) {
      showFieldError(field, body.error[0].toUpperCase() + body.error.slice(1));
      focusField(field);
    } else {
      alertBox.textContent = body.error || "The request was not sent. Try again.";
      alertBox.hidden = false;
    }
  } catch {
    alertBox.textContent = "The request was not sent. Check your connection and try again. Your details are still here.";
    alertBox.hidden = false;
  } finally {
    setSending(false);
  }
});

message.addEventListener("input", updateMessageCount);

document.getElementById("another").addEventListener("click", () => {
  form.reset();
  clearErrors();
  updateMessageCount();
  receipt.hidden = true;
  form.hidden = false;
  form.elements.name.focus();
});
