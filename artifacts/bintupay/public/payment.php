<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With");
header("Content-Type: application/json; charset=UTF-8");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

error_reporting(0);
ini_set('display_errors', 0);
ini_set('html_errors', 0);

$secret_key = "`PICATIC_API_KEY`61ea0dcb";

function paystackRequest($url, $data = null) {
    global $secret_key;
    $ch = curl_init($url);

    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);

    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Authorization: Bearer " . $secret_key,
        "Content-Type: application/json",
        "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cache-Control: no-cache"
    ]);

    if ($data !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    }

    $result = curl_exec($ch);
    curl_close($ch);
    return $result;
}

function formatKenyanNumber($phone) {
    $phone = preg_replace('/[^0-9]/', '', $phone);
    if (preg_match('/^0[17]\d{8}$/', $phone)) return '+254' . substr($phone, 1);
    if (preg_match('/^254[17]\d{8}$/', $phone)) return '+' . $phone;
    if (preg_match('/^\+254[17]\d{8}$/', '+' . $phone)) return '+' . $phone;
    return false;
}

$action = $_GET['action'] ?? '';

// ─── M-Pesa STK Push ─────────────────────────────────────────────────────────
if ($action === "charge") {
    $input = json_decode(file_get_contents("php://input"), true);
    $rawPhone = $input["phone"] ?? "";
    $amount   = $input["amount"] ?? "";

    if (empty($rawPhone) || empty($amount)) {
        echo json_encode(["status" => false, "message" => "Phone number and amount required."]);
        exit;
    }

    $formattedPhone = formatKenyanNumber($rawPhone);
    if (!$formattedPhone) {
        echo json_encode(["status" => false, "message" => "Invalid format. Use 07XXXXXXXX or 01XXXXXXXX."]);
        exit;
    }

    $cleanDigits  = str_replace('+', '', $formattedPhone);
    $dynamicEmail = "user_" . $cleanDigits . "@bintupay.com";

    $payload = [
        "email"        => $dynamicEmail,
        "amount"       => round(floatval($amount) * 100),
        "currency"     => "KES",
        "mobile_money" => [
            "phone"    => $formattedPhone,
            "provider" => "mpesa"
        ]
    ];

    $res          = paystackRequest("https://api.paystack.co/charge", $payload);
    $responseData = json_decode($res, true);

    if (isset($responseData['status']) && $responseData['status'] == true) {
        echo json_encode([
            "status" => true,
            "data"   => [
                "reference" => $responseData['data']['reference'],
                "status"    => $responseData['data']['status']
            ]
        ]);
    } else {
        echo $res ? $res : json_encode(["status" => false, "message" => "Empty response from billing gateway."]);
    }
    exit;
}

// ─── Credit / Debit Card Charge ───────────────────────────────────────────────
if ($action === "card") {
    $input      = json_decode(file_get_contents("php://input"), true);
    $amount     = $input["amount"]      ?? "";
    $cardNumber = preg_replace('/\s+/', '', $input["card_number"] ?? "");
    $expiry     = $input["expiry"]      ?? "";   // expects MM/YY
    $cvv        = $input["cvv"]         ?? "";
    $name       = $input["name"]        ?? "";

    if (empty($amount) || empty($cardNumber) || empty($expiry) || empty($cvv) || empty($name)) {
        echo json_encode(["status" => false, "message" => "All card fields and amount are required."]);
        exit;
    }

    // Parse expiry — accept MM/YY or MM/YYYY
    $expiryParts = explode('/', $expiry);
    if (count($expiryParts) !== 2) {
        echo json_encode(["status" => false, "message" => "Invalid expiry format. Use MM/YY."]);
        exit;
    }

    $expiryMonth = str_pad(trim($expiryParts[0]), 2, '0', STR_PAD_LEFT);
    $expiryYearRaw = trim($expiryParts[1]);
    // Normalise 2-digit year → 4-digit year
    $expiryYear = strlen($expiryYearRaw) === 2 ? '20' . $expiryYearRaw : $expiryYearRaw;

    // Derive a deterministic email from the last 4 digits of the card
    $last4        = substr($cardNumber, -4);
    $dynamicEmail = "card_" . $last4 . "_" . time() . "@bintupay.com";

    $payload = [
        "email"    => $dynamicEmail,
        "amount"   => round(floatval($amount) * 100),
        "currency" => "KES",
        "card"     => [
            "number"       => $cardNumber,
            "cvv"          => $cvv,
            "expiry_month" => $expiryMonth,
            "expiry_year"  => $expiryYear
        ]
    ];

    $res          = paystackRequest("https://api.paystack.co/charge", $payload);
    $responseData = json_decode($res, true);

    if (!$responseData) {
        echo json_encode(["status" => false, "message" => "Empty or malformed response from payment gateway."]);
        exit;
    }

    if (isset($responseData['status']) && $responseData['status'] == true) {
        $txData   = $responseData['data'];
        $txStatus = $txData['status'] ?? '';

        // Paystack card statuses: success, failed, send_otp, send_pin, open_url, timeout
        if ($txStatus === 'success') {
            echo json_encode([
                "status" => true,
                "data"   => [
                    "reference"        => $txData['reference'],
                    "status"           => "success",
                    "gateway_response" => $txData['gateway_response'] ?? 'Approved'
                ]
            ]);
        } elseif ($txStatus === 'failed') {
            echo json_encode([
                "status"  => false,
                "message" => $txData['gateway_response'] ?? "Card charge declined."
            ]);
        } else {
            // Pending / awaiting OTP — return reference so frontend can poll
            echo json_encode([
                "status" => true,
                "data"   => [
                    "reference"        => $txData['reference'],
                    "status"           => $txStatus,
                    "gateway_response" => $txData['gateway_response'] ?? 'Processing'
                ]
            ]);
        }
    } else {
        $errMsg = $responseData['message'] ?? "Card charge failed.";
        echo json_encode(["status" => false, "message" => $errMsg]);
    }
    exit;
}

// ─── Transaction Verify (shared by both M-Pesa and Card) ─────────────────────
if ($action === "verify") {
    $reference = $_GET['reference'] ?? '';
    if (empty($reference)) {
        echo json_encode(["status" => false, "message" => "Verification reference token required."]);
        exit;
    }

    $res          = paystackRequest("https://api.paystack.co/transaction/verify/" . urlencode($reference));
    $responseData = json_decode($res, true);

    if (isset($responseData['status']) && $responseData['status'] == true) {
        echo json_encode([
            "status" => true,
            "data"   => [
                "status"           => $responseData['data']['status'],
                "gateway_response" => $responseData['data']['gateway_response'] ?? 'Transaction updating'
            ]
        ]);
    } else {
        echo $res ? $res : json_encode(["status" => false, "message" => "Empty response from verification endpoint."]);
    }
    exit;
}

echo json_encode(["status" => false, "message" => "Invalid action context."]);
