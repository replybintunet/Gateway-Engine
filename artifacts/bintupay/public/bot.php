<?php
ini_set('display_errors', 0);
error_reporting(0);
set_time_limit(120);

// ─── Configuration ────────────────────────────────────────────────────────────
$token = "8929567292:AAHom3_tgdLdBM3rJl2GTCO5TdG6GkM3KUA";
$api   = "https://api.telegram.org/bot$token/";

$charge_url = "http://localhost/payment.php?action=charge";
$verify_url = "http://localhost/payment.php?action=verify";

// ─── Close connection IMMEDIATELY so Telegram doesn't wait ───────────────────
// This sends HTTP 200 back to Telegram right away and frees the webhook.
// The script keeps running in the background to poll and send follow-up messages.
ignore_user_abort(true);
ob_start();
header("Content-Type: application/json");
header("Connection: close");
echo json_encode(["ok" => true]);
$size = ob_get_length();
header("Content-Length: $size");
ob_end_flush();
@ob_flush();
flush();
if (function_exists("fastcgi_finish_request")) {
    fastcgi_finish_request();
}

// ─── Input parsing ────────────────────────────────────────────────────────────
$update = json_decode(file_get_contents("php://input"), true);

if (!$update || !isset($update["message"])) {
    exit;
}

$chat_id     = $update["message"]["chat"]["id"];
$first_name  = $update["message"]["chat"]["first_name"] ?? "there";
$text        = trim($update["message"]["text"] ?? "");
$reply_to    = $update["message"]["reply_to_message"] ?? null;
$reply_text  = $reply_to["text"] ?? "";

// ─── Command routing ──────────────────────────────────────────────────────────

if ($text === "/start" || $text === "/pay" || $text === "1" || strtolower($text) === "pay") {
    sendForceReply(
        $chat_id,
        "👋 Welcome back, *{$first_name}*\!\n\n" .
        "You\'ve reached the *BintuPay Secure Payment Portal*\.\n\n" .
        "Please enter the *exact amount* you wish to pay \\(in KES\\)\\. For example: `500`"
    );
    exit;
}

if ($text === "/help") {
    sendMessage(
        $chat_id,
        "🛡 *BintuPay Payment Bot — Help Guide*\n\n" .
        "Here\'s how to make a payment:\n\n" .
        "1\\. Type `/pay` or `1` to start a new transaction\n" .
        "2\\. Enter your payment amount when prompted\n" .
        "3\\. Enter your M\\-Pesa phone number\n" .
        "4\\. Check your phone for the STK push and enter your PIN\n" .
        "5\\. Receive instant confirmation once payment is verified\n\n" .
        "*Need support?* Contact your service provider with your transaction reference\.\n\n" .
        "_All transactions are secured end\\-to\\-end via Paystack\\._"
    );
    exit;
}

if ($text === "/status") {
    sendForceReply(
        $chat_id,
        "🔍 *Transaction Status Check*\n\nPlease enter your *transaction reference* to check its current status:"
    );
    exit;
}

// ─── Conversational reply handling ───────────────────────────────────────────
if ($reply_to) {

    // STEP 1: Amount input
    if (strpos($reply_text, "exact amount") !== false) {
        if (!is_numeric($text) || intval($text) < 10) {
            sendForceReply(
                $chat_id,
                "⚠️ *Invalid Amount*\n\n" .
                "The value you entered is not valid\\. Minimum transaction is KES 10\\.\n\n" .
                "Please enter a valid amount \\(KES\\):"
            );
            exit;
        }
        $formatted = number_format(intval($text));
        sendForceReply(
            $chat_id,
            "✅ *Amount Set:* KES {$formatted}\n\n" .
            "Now please enter the *M\\-Pesa phone number* to charge\\.\n" .
            "Accepted formats: `07XXXXXXXX` or `01XXXXXXXX`"
        );
        exit;
    }

    // STEP 2: Phone number input → trigger charge + poll
    if (strpos($reply_text, "M-Pesa phone number") !== false || strpos($reply_text, "phone number") !== false) {
        preg_match('/KES\s*([\d,]+)/i', $reply_text, $matches);
        $amount = isset($matches[1]) ? (int) str_replace(',', '', $matches[1]) : 0;

        if (!$amount) {
            sendMessage(
                $chat_id,
                "⚠️ *Session Expired*\n\nWe could not retrieve your session details\\. Please type `/pay` to start a new transaction\."
            );
            exit;
        }

        $phone = preg_replace('/[^0-9]/', '', $text);
        if (!preg_match('/^(07|01)\d{8}$/', $phone)) {
            sendForceReply(
                $chat_id,
                "⚠️ *Invalid Phone Number*\n\n" .
                "The number `{$phone}` is not recognised\\. Please use the format `07XXXXXXXX` or `01XXXXXXXX`:"
            );
            exit;
        }

        // Acknowledge immediately — connection is already closed so this shows instantly
        sendMessage($chat_id,
            "⏳ *Initiating Secure Transaction\\.\\.\\.*\n\n" .
            "_Connecting to M\\-Pesa for KES " . number_format($amount) . " — please wait a moment\\._"
        );

        $response = postJSON($charge_url, ["amount" => $amount, "phone" => $phone]);

        if (
            isset($response["status"]) &&
            $response["status"] == true &&
            isset($response["data"]["reference"])
        ) {
            $reference = $response["data"]["reference"];

            sendMessage($chat_id,
                "📲 *STK Push Sent Successfully*\n\n" .
                "A payment request of *KES " . number_format($amount) . "* has been sent to *{$phone}*\\.\n\n" .
                "👉 Open your phone and enter your *M\\-Pesa PIN* to complete the payment\\.\n\n" .
                "🔐 Reference: `{$reference}`\n\n" .
                "⏳ _Monitoring status — you will be notified the moment it confirms\\._"
            );

            // Poll every 3 seconds for up to 50 seconds (16 checks)
            $max_checks  = 16;
            $is_resolved = false;

            for ($i = 0; $i < $max_checks; $i++) {
                sleep(3);

                $check  = getJSON($verify_url . "&reference=" . urlencode($reference));
                $status = $check["data"]["status"]           ?? "pending";
                $gw_msg = $check["data"]["gateway_response"] ?? "Unknown reason";

                if ($status === "success") {
                    sendMessage($chat_id,
                        "🎉 *Payment Confirmed\!*\n\n" .
                        "━━━━━━━━━━━━━━━━━━━━\n" .
                        "💰 *Amount:* KES " . number_format($amount) . "\n" .
                        "📱 *Phone:* `{$phone}`\n" .
                        "🆔 *Reference:* `{$reference}`\n" .
                        "✅ *Status:* Successful\n" .
                        "━━━━━━━━━━━━━━━━━━━━\n\n" .
                        "Your payment has been received and confirmed\\. Thank you for using *BintuPay*\\!\n\n" .
                        "_Type `/pay` to make another payment\\._"
                    );
                    $is_resolved = true;
                    break;
                }

                if ($status === "failed") {
                    sendMessage($chat_id,
                        "❌ *Transaction Declined*\n\n" .
                        "Your payment of KES " . number_format($amount) . " could not be processed\\.\n\n" .
                        "📋 *Reason:* `{$gw_msg}`\n\n" .
                        "Please check:\n" .
                        "• Your M\\-Pesa balance is sufficient\n" .
                        "• Your PIN was entered correctly\n" .
                        "• You have not exceeded your daily limit\n\n" .
                        "_Type `/pay` to retry\\._"
                    );
                    $is_resolved = true;
                    break;
                }

                // Midway nudge at ~24 seconds
                if ($i === 7) {
                    sendMessage($chat_id,
                        "🔄 _Still waiting for your PIN confirmation\\. Please check your phone and enter your M\\-Pesa PIN\\._"
                    );
                }
            }

            if (!$is_resolved) {
                sendMessage($chat_id,
                    "⏰ *Verification Timeout*\n\n" .
                    "We could not confirm your transaction within 50 seconds\\.\n\n" .
                    "🔍 *Reference:* `{$reference}`\n\n" .
                    "Your payment may still be processing\\. Check your M\\-Pesa messages for confirmation\\. " .
                    "If funds were deducted without service delivery, contact support with the reference above\\.\n\n" .
                    "_Type `/pay` to start a new transaction\\._"
                );
            }

        } else {
            $error = $response["message"] ?? "The gateway rejected the request. Please verify your details.";
            sendMessage($chat_id,
                "❌ *Payment Initialisation Failed*\n\n" .
                "📋 *Reason:* " . escapeMarkdown($error) . "\n\n" .
                "_Type `/pay` to try again\\._"
            );
        }
        exit;
    }

    // STEP 3: Reference status lookup
    if (strpos($reply_text, "transaction reference") !== false) {
        $reference = trim($text);
        sendMessage($chat_id, "🔍 _Checking status for `" . escapeMarkdown($reference) . "`\\.\\.\\._");
        $check  = getJSON($verify_url . "&reference=" . urlencode($reference));
        $status = $check["data"]["status"]           ?? null;
        $gw_msg = $check["data"]["gateway_response"] ?? "Unknown";

        if ($status === "success") {
            sendMessage($chat_id,
                "✅ *Transaction Confirmed*\n\n" .
                "🆔 *Reference:* `" . escapeMarkdown($reference) . "`\n" .
                "📋 *Status:* Successful\n\n" .
                "_This transaction completed successfully\\._"
            );
        } elseif ($status === "failed") {
            sendMessage($chat_id,
                "❌ *Transaction Failed*\n\n" .
                "🆔 *Reference:* `" . escapeMarkdown($reference) . "`\n" .
                "📋 *Reason:* `" . escapeMarkdown($gw_msg) . "`\n\n" .
                "_Type `/pay` to retry\\._"
            );
        } elseif ($status) {
            sendMessage($chat_id,
                "⏳ *Transaction Pending*\n\n" .
                "🆔 *Reference:* `" . escapeMarkdown($reference) . "`\n" .
                "📋 *Status:* `{$status}`\n\n" .
                "_The transaction is still being processed\\. Check again in a moment\\._"
            );
        } else {
            sendMessage($chat_id,
                "⚠️ *Reference Not Found*\n\n" .
                "No transaction was found for `" . escapeMarkdown($reference) . "`\\. " .
                "Please double\\-check the reference and try again\\."
            );
        }
        exit;
    }
}

// ─── Fallback ─────────────────────────────────────────────────────────────────
sendMessage($chat_id,
    "ℹ️ *BintuPay Payment Bot*\n\n" .
    "• Type `/pay` or `1` to begin a new payment\n" .
    "• Type `/status` to check a transaction\n" .
    "• Type `/help` for full instructions"
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeMarkdown($text) {
    return preg_replace('/([_\*\[\]\(\)~`>#+\-=|{}.!\\\\])/', '\\\\$1', $text);
}

function sendMessage($chat_id, $text) {
    global $api;
    $ch = curl_init($api . "sendMessage");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_POSTFIELDS     => [
            "chat_id"    => $chat_id,
            "text"       => $text,
            "parse_mode" => "MarkdownV2",
        ],
    ]);
    curl_exec($ch);
    curl_close($ch);
}

function sendForceReply($chat_id, $text) {
    global $api;
    $ch = curl_init($api . "sendMessage");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_POSTFIELDS     => [
            "chat_id"      => $chat_id,
            "text"         => $text,
            "parse_mode"   => "MarkdownV2",
            "reply_markup" => json_encode(["force_reply" => true, "selective" => true]),
        ],
    ]);
    curl_exec($ch);
    curl_close($ch);
}

function postJSON($url, $data) {
    $ctx = stream_context_create(["http" => [
        "header"        => "Content-Type: application/json\r\n",
        "method"        => "POST",
        "content"       => json_encode($data),
        "ignore_errors" => true,
        "timeout"       => 10,
    ]]);
    return json_decode(@file_get_contents($url, false, $ctx), true) ?? [];
}

function getJSON($url) {
    $ctx = stream_context_create(["http" => [
        "ignore_errors" => true,
        "timeout"       => 8,
    ]]);
    return json_decode(@file_get_contents($url, false, $ctx), true) ?? [];
}
?>
