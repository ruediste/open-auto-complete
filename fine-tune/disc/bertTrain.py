# %%
# %pip install tokenizers

# %%

from datasets import load_dataset
dataset=load_dataset('parquet',data_files=["data/data.parquet"], streaming=True)['train']
dataset


# %%
from transformers import PreTrainedTokenizerFast, AutoTokenizer
tokenizer=AutoTokenizer.from_pretrained('data/bert')

# %%
import random
def generateExamples(rows):
    prefixes=[]
    suffixes=[]
    completions=[]
    paths=[]
    languages=[]
    chunkSize=1000    
    for i,code in enumerate(rows["code"]):
        base=0;
        while base < len(code):
            for completionSize in [0,5,10,20,100,200,400]:
              idx=random.randint(base, min(len(code),base+chunkSize))
              prefixes.append(code[max(0,idx-200):idx])
              completions.append(code[idx:idx+completionSize])
              suffixes.append(code[idx+completionSize:idx+completionSize+10])
              paths.append(rows['path'][i])
              languages.append(rows['language'][i])
            base+=chunkSize
    return {"prefix":prefixes, "suffix":suffixes, "completion":completions, "path":paths, "language": languages}

ds=dataset.shuffle(seed=42).map(lambda rows:generateExamples(rows), batched=True, remove_columns=['code','size','license','repo_name'])
ds

# %%

pad = tokenizer.convert_tokens_to_ids("<|pad|>")
mask = tokenizer.convert_tokens_to_ids("<|mask|>")
cls = tokenizer.convert_tokens_to_ids("<|cls|>")
languageTokens={
    'cs': tokenizer.convert_tokens_to_ids("<|cs|>"),
    'css': tokenizer.convert_tokens_to_ids("<|css|>"),
    'ts': tokenizer.convert_tokens_to_ids("<|ts|>"),
};
languageIds={
    'cs': 0,
    'ts': 1,
    'css': 2,
};

predictionTokens=5

def tokenize_function(examples):
    # Tokenize all prefixes and suffixes together
    prefix_ids = tokenizer(examples["prefix"], add_special_tokens=False, split_special_tokens=True)["input_ids"]
    suffix_ids = tokenizer(examples["suffix"], add_special_tokens=False,split_special_tokens=True)["input_ids"]
    completion_ids = tokenizer(examples["completion"], add_special_tokens=False, split_special_tokens=True)["input_ids"]
    
    # Combine the IDs for each example in the batch
    # [languageTokens[lang]]
    input_ids = [
       prefix + [mask]*predictionTokens + suffix 
       for prefix, suffix, lang in zip(prefix_ids, suffix_ids, examples["language"])
    ]

    # Create labels, replacing prefix and suffix with -100
    label_ids =  [
       prefix + completion[:predictionTokens]+[pad]*(max(0,predictionTokens-len(completion))) + suffix 
       for prefix,completion, suffix, lang in zip(prefix_ids, completion_ids, suffix_ids, examples["language"])
    ]

    attention_mask = [[1] * len(ids) for ids in input_ids]

    return {
        "input_ids": input_ids,
        "labels": label_ids,
        "attention_mask":attention_mask,
        "token_type_ids": [[languageIds[lang]] * len(ids) for ids,lang in zip(input_ids,examples["language"])]
    }

tokenized_dataset = ds.shuffle(seed=42).map(tokenize_function, batched=True,batch_size=10,remove_columns=['path','language','prefix','suffix','completion'])
tokenized_dataset

# %%
for ex in tokenized_dataset.take(2):
    print(ex['input_ids'])
    print(ex['labels'])
    print(ex['token_type_ids'])
    print(len(ex['input_ids']))
    print(len(ex['labels']))
    print(len(ex['attention_mask']))
    print(len(ex['token_type_ids']))

# %%
from transformers import BertModel, BertForMaskedLM, BertConfig

config=BertConfig(
    vocab_size=tokenizer.vocab_size, 
    hidden_size=512, 
    num_hidden_layers=4, 
    num_attention_heads=8, 
    intermediate_size=2048, 
    max_position_embeddings=2048,
    token_type_ids=3,
    )
model=BertForMaskedLM(config)
# %%

# %%
def print_trainable_parameters(model):
    """
    Prints the number of trainable parameters in the model.
    """
    trainable_params = 0
    all_param = 0
    for _, param in model.named_parameters():
        all_param += param.numel()
        if param.requires_grad:
            trainable_params += param.numel()
    print(
        f"trainable params: {trainable_params} || all params: {all_param} || trainable: {100 * trainable_params / all_param}%"
    )
print_trainable_parameters(model)

# %%
# splitds=tokenized_dataset.train_test_split(2000)
splitds={}
splitds['test']=tokenized_dataset.take(2000)
splitds['train']=tokenized_dataset.skip(2000)

# %%
from typing import Dict, List, Optional, Union
from transformers import TrainingArguments,Trainer,EvalPrediction
import torch
from torch.utils.data import Dataset
import math
from torch.optim.lr_scheduler import LambdaLR
import time


def padToLength(list,length, padding):
    result=list[:length]
    return result + [padding]*(length-len(result));

class MyDataCollator:
    def __call__(self, features) :
        max_length = max([len(feature['input_ids']) for feature in features])
        max_length=16*math.ceil(max_length/16)
        return {
            "input_ids": torch.tensor([padToLength(feature['input_ids'],max_length, tokenizer.pad_token_id ) for feature in features], dtype=torch.int64),
            "labels": torch.tensor([padToLength(feature['labels'],max_length, -100 ) for feature in features], dtype=torch.int64),
            "attention_mask":torch.tensor([padToLength(feature['attention_mask'],max_length, 0 ) for feature in features], dtype=torch.int64),
        }

batch_size = 64

training_args = TrainingArguments(
    num_train_epochs=2,
    output_dir="data/check",
    overwrite_output_dir=True,
    # eval_strategy="steps",
    # eval_steps=1000,
    eval_strategy="steps",
    eval_steps=2000,
    logging_strategy="steps",
    logging_steps=1000,
    save_strategy="steps",
    save_steps=30000,
    learning_rate=2e-5,
    weight_decay=0.01,
    per_device_train_batch_size=batch_size,
    per_device_eval_batch_size=batch_size,
    fp16=True,
    eval_on_start=True,
    max_steps=2**30
    #  gradient_checkpointing=True,
    # gradient_accumulation_steps=4,
    )

class Scheduler:
    def __init__(self):
        self.factor=1;
        self.last_loss=None
        self.last_time=time.time()
        self.metrics=None
        self.time_elapsed=False

    def __call__(self, step: int):
        if self.last_loss is None and self.metrics is not None:
            self.last_loss=self.metrics['eval_loss']
            
        if self.time_elapsed:
            if self.metrics is not None:
                loss=self.metrics['eval_loss']
                if loss/self.last_loss>0.95:
                    # loss fell too slow, reduce lr
                    print("LR Scheduler: reduce LR in step "+str(step))
                    self.factor*=0.8;
                self.last_loss=loss;
                self.last_time=time.time();
                self.time_elapsed=False
        else:
            if time.time()-self.last_time > 30*60:
                self.time_elapsed=True
                # clear the metrics and wait for the next fresh evaluation
                self.metrics=None
        return self.factor;

scheduler=Scheduler()

class MyTrainer(Trainer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    def create_scheduler(self,num_training_steps: int, optimizer: torch.optim.Optimizer = None):
        self.lr_scheduler=LambdaLR(optimizer, scheduler)
        return self.lr_scheduler
    
    def evaluate(
        self,
        eval_dataset: Optional[Union[Dataset, Dict[str, Dataset]]] = None,
        ignore_keys: Optional[List[str]] = None,
        metric_key_prefix: str = "eval",
    ) -> Dict[str, float]:
        metrics= super().evaluate(eval_dataset, ignore_keys, metric_key_prefix)
        scheduler.metrics=metrics
        return metrics

trainer = MyTrainer(
    model=model,
    args=training_args,
    train_dataset=splitds["train"],
    eval_dataset=splitds["test"],
    data_collator=MyDataCollator(),
    processing_class=tokenizer,
    # compute_metrics=compute_metrics
)

# trainer.train()
trainer.train(resume_from_checkpoint=True)

trainer.save_model('data/bert1')

# %%
def compute_metrics(e: EvalPrediction):
    # print('compute metrics '+str(e.label_ids))
    res=e.predictions.argmax(-1)
    # print(e.label_ids)
    for prediction,labels in zip(res,e.label_ids):
        print("===***")
        print(tokenizer.decode(prediction, skip_special_tokens=True,))
        print("---")
        print(tokenizer.decode(list(filter(lambda x: x != -100, labels)), skip_special_tokens=True,))
        print("===+++")

    return {'eval_loss':1}


