
import OpenAI from "openai";

const client = new OpenAI();


//tools : [{"type":"web_search"}]
async function call_llm(message,tools,config){
var messages = [{"role":"user","message":message}]

let i = 0;
// for(i=0;i<50;i++){
    const response = await client.responses.create({
    model: config.model,
    input: message,
    tools: tools,
    max_output_tokens: config.max_output_tokens,
    tool_choice:"auto",
    reasoning:false,
    
    });
    messages.push({"role":"assistant","message":response.output_text})
    console.log(messages)

// }


}
